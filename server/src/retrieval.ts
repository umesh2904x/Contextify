import { db, j, unj } from "./db.js";
import { cosine, embedOne, fromBlob, toBlob, EMBED_DIM } from "./embed.js";
import { heuristicLang as detectLanguage, scriptOf } from "./providers/sarvam.js";

export type Candidate = {
  chunk_id: string;
  doc_id: string;
  page_no: number;
  text: string;
  lang: string;
  kind: string;
  section_path: string;
  bbox: Array<[number, number, number, number]>;
  page_width: number;
  page_height: number;
  filename: string;
  doc_title: string;
  bm25: number;
  dense: number;
  rrf: number;
  rerank: number;
  snippet: string;
};

export async function indexChunk(c: {
  id: string;
  doc_id: string;
  text: string;
  lang?: string;
  page_no: number;
  ord: number;
  kind: string;
  section_path: string;
  bbox: unknown;
  meta?: unknown;
}): Promise<void> {
  let lang = c.lang ?? "";
  if (!lang) {
    lang = detectLanguage(c.text.slice(0, 400));
  }
  const vec = await embedOne(c.text, "passage");
  const tokenEst = Math.ceil(c.text.length / 3.2);

  db.prepare(
    `INSERT OR REPLACE INTO chunks (id, doc_id, page_no, ord, text, lang, kind, section_path, bbox, meta, token_est)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(c.id, c.doc_id, c.page_no, c.ord, c.text, lang, c.kind, c.section_path, j(c.bbox), j(c.meta ?? {}), tokenEst);

  db.prepare(`DELETE FROM chunks_fts WHERE chunk_id = ?`).run(c.id);
  db.prepare(`INSERT INTO chunks_fts (text, chunk_id, doc_id, lang) VALUES (?,?,?,?)`).run(c.text, c.id, c.doc_id, lang);

  db.prepare(`INSERT OR REPLACE INTO vectors (chunk_id, doc_id, dim, vec, model) VALUES (?,?,?,?,?)`).run(
    c.id,
    c.doc_id,
    vec.length || EMBED_DIM,
    toBlob(vec),
    "e5-hash",
  );
}

export function dropDocumentIndex(docId: string): void {
  db.prepare(`DELETE FROM chunks_fts WHERE doc_id = ?`).run(docId);
  db.prepare(`DELETE FROM vectors WHERE doc_id = ?`).run(docId);
  db.prepare(`DELETE FROM chunks WHERE doc_id = ?`).run(docId);
}

/* ---------------- BM25 (FTS5) ---------------- */

export type Bm25Hit = { chunk_id: string; score: number };

export function bm25(query: string, lang?: string, limit = 60): Bm25Hit[] {
  const baseTokens = query
    .replace(/["*]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 24);
  const classAliases = [...query.matchAll(/\b(TE|SE|BE)\s*(?:IT\s*)?([ABC])\b/gi)]
    .map((match) => `${match[1]}IT${match[2]}`);
  const cleaned = [...new Set([...baseTokens, ...classAliases])];
  if (!cleaned.length) return [];
  const expr = cleaned.map((t) => `"${t}"`).join(" OR ");
  const rows = db
    .prepare(
      `SELECT chunk_id, bm25(chunks_fts, 1.0) AS s FROM chunks_fts
       WHERE chunks_fts MATCH ? ${lang ? "AND lang = ?" : ""}
       ORDER BY s LIMIT ?`,
    )
    .all(...(lang ? [expr, lang, limit] : [expr, limit])) as Array<{ chunk_id: string; s: number }>;
  return rows.map((r) => ({ chunk_id: r.chunk_id, score: -r.s }));
}

/* ---------------- dense scan ---------------- */

export function denseSearch(qv: Float32Array, limit = 60, docId?: string): Array<{ chunk_id: string; score: number }> {
  const rows = (
    docId
      ? db.prepare(`SELECT chunk_id, vec FROM vectors WHERE doc_id = ?`).all(docId)
      : db.prepare(`SELECT chunk_id, vec FROM vectors`).all()
  ) as Array<{ chunk_id: string; vec: Uint8Array }>;
  const scored: Array<{ chunk_id: string; score: number }> = [];
  for (const r of rows) {
    const v = fromBlob(r.vec);
    scored.push({ chunk_id: r.chunk_id, score: cosine(qv, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/* ---------------- hybrid + RRF ---------------- */

const RRF_K = 60;

export type RetrieveOpts = {
  topK?: number;
  crossLingual?: boolean;
  docId?: string;
  rerank?: boolean;
};

export async function retrieve(query: string, opts: RetrieveOpts = {}): Promise<Candidate[]> {
  const topK = opts.topK ?? 8;
  const qLang = detectLanguage(query.slice(0, 300));

  const qv = await embedOne(query, "query");
  const primary = opts.crossLingual ? bm25(query) : bm25(query, qLang);
  const secondary = opts.crossLingual ? [] : bm25(query);
  const dense = denseSearch(qv, 80, opts.docId);

  const fused = new Map<string, { bm: number; dn: number; rrf: number }>();
  const bump = (id: string, key: "bm" | "dn", score: number, rank: number) => {
    const cur = fused.get(id) ?? { bm: 0, dn: 0, rrf: 0 };
    cur[key] = Math.max(cur[key], score);
    cur.rrf += 1 / (RRF_K + rank);
    fused.set(id, cur);
  };
  [...primary, ...secondary].forEach((h, i) => bump(h.chunk_id, "bm", h.score, i + 1));
  dense.forEach((h, i) => bump(h.chunk_id, "dn", h.score, i + 1));

  const ids = [...fused.keys()].slice(0, 60);
  if (!ids.length) return [];

  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT c.id, c.doc_id, c.page_no, c.text, c.lang, c.kind, c.section_path, c.bbox,
              d.filename, d.title, p.width AS page_width, p.height AS page_height
       FROM chunks c
       JOIN documents d ON d.id = c.doc_id
       LEFT JOIN pages p ON p.doc_id = c.doc_id AND p.page_no = c.page_no
       WHERE c.id IN (${placeholders})`,
    )
    .all(...ids) as any[];

  const out: Candidate[] = rows.map((r) => {
    const f = fused.get(r.id)!;
    return {
      chunk_id: r.id,
      doc_id: r.doc_id,
      page_no: r.page_no,
      text: r.text,
      lang: r.lang,
      kind: r.kind,
      section_path: unj<string>(r.section_path, ""),
      bbox: unj<Array<[number, number, number, number]>>(r.bbox, []),
      page_width: Number(r.page_width ?? 0) || 0,
      page_height: Number(r.page_height ?? 0) || 0,
      filename: r.filename,
      doc_title: r.title ?? r.filename,
      bm25: f.bm,
      dense: f.dn,
      rrf: f.rrf,
      rerank: 0,
      snippet: r.text.length > 420 ? r.text.slice(0, 420) + "…" : r.text,
    };
  });

  out.sort((a, b) => b.rrf - a.rrf);
  const top = out.slice(0, Math.max(topK * 3, 20));

  if (opts.rerank !== false) await lexicalRerank(query, top, qLang);

  return top.sort((a, b) => b.rrf - a.rrf).slice(0, topK);
}

function tokenSet(s: string): Set<string> {
  const normalized = s.replace(/\b(TE|SE|BE)IT([ABC])\b/gi, "$1 IT $2");
  return new Set((normalized.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []));
}

async function lexicalRerank(query: string, cands: Candidate[], qLang: string): Promise<void> {
  const q = tokenSet(query);
  if (!q.size) return;
  const qt = scriptOf(qLang);
  for (const c of cands) {
    const t = tokenSet(c.text);
    let overlap = 0;
    for (const w of q) if (t.has(w)) overlap++;
    const coverage = overlap / q.size;
    const sameScript = scriptOf(c.lang) === qt ? 0.08 : 0;
    const tableBoost = c.kind === "table" ? 0.05 : 0;
    const numBoost = /\d/.test(query) && /\d/.test(c.text) ? 0.06 : 0;
    c.rerank = coverage * 0.5 + sameScript + tableBoost + numBoost;
    c.rrf = c.rrf * 10 + c.rerank;
  }
}

export function corpusStats(): { chunks: number; docs: number; vectors: number; langs: Array<{ lang: string; n: number }> } {
  const chunks = (db.prepare(`SELECT COUNT(*) n FROM chunks`).get() as any).n as number;
  const docs = (db.prepare(`SELECT COUNT(*) n FROM documents WHERE status='ready'`).get() as any).n as number;
  const vectors = (db.prepare(`SELECT COUNT(*) n FROM vectors`).get() as any).n as number;
  const langs = db.prepare(`SELECT lang, COUNT(*) n FROM chunks GROUP BY lang ORDER BY n DESC`).all() as any[];
  return { chunks, docs, vectors, langs };
}
