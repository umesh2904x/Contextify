import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClient } from "@supabase/supabase-js";
import Busboy from "busboy";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { PORT, RENDER_DIR, EMBED_MODEL, SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { db, j, now, uid, unj } from "./db.js";
import { initEmbeddings, embedStatus } from "./embed.js";
import { corpusStats, dropDocumentIndex } from "./retrieval.js";
import { createDoc, ingestDocument, startWorker, storeUpload, pendingJobCount } from "./ingest/pipeline.js";
import { isSupportedUpload } from "./ingest/office.js";
import { renderPathFor } from "./ingest/render.js";
import { ask, addMessage, conflictLines, history, listConversations, listMessages, newConversation } from "./answer.js";
import { sarvamReachable, ollamaReachable, heuristicLang, translate } from "./providers/sarvam.js";

const app = new Hono();
app.use("/api/*", cors());

const authClient = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null;
const LOCAL_ACCESS_BEARER = "contextify-local-access-session";

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/ui/translate") return next();
  const token = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
  if (process.env.NODE_ENV !== "production" && token === LOCAL_ACCESS_BEARER) return next();
  if (!authClient) return c.json({ error: "Authentication is not configured" }, 503);
  if (!token) return c.json({ error: "Sign-in required" }, 401);

  try {
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) return c.json({ error: "Invalid or expired session" }, 401);
  } catch {
    return c.json({ error: "Unable to verify sign-in" }, 503);
  }

  await next();
});

const UI_LANGUAGES = new Set(["as-IN", "bn-IN", "brx-IN", "doi-IN", "gu-IN", "hi-IN", "kn-IN", "ks-IN", "kok-IN", "mai-IN", "ml-IN", "mni-IN", "mr-IN", "ne-IN", "od-IN", "pa-IN", "sa-IN", "sat-IN", "sd-IN", "ta-IN", "te-IN", "ur-IN"]);
const uiTranslationCache = new Map<string, string>();
let uiTranslationWindow = Date.now();
let uiTranslationRequests = 0;

app.post("/api/ui/translate", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { language?: unknown; strings?: unknown } | null;
  if (typeof body?.language !== "string" || !UI_LANGUAGES.has(body.language) || !Array.isArray(body.strings)) {
    return c.json({ error: "Unsupported language request" }, 400);
  }
  const strings = body.strings;
  if (strings.length > 120 || strings.some((text) => typeof text !== "string" || text.length > 300) || strings.reduce((sum, text) => sum + String(text).length, 0) > 8000) {
    return c.json({ error: "Translation request is too large" }, 413);
  }
  if (Date.now() - uiTranslationWindow > 60_000) {
    uiTranslationWindow = Date.now();
    uiTranslationRequests = 0;
  }
  if (++uiTranslationRequests > 20) return c.json({ error: "Please wait before changing languages again" }, 429);

  const output = new Array<string>(strings.length);
  const uncached: Array<{ index: number; text: string }> = [];
  strings.forEach((text, index) => {
    const source = String(text);
    const key = `${body.language}\0${source}`;
    const cached = uiTranslationCache.get(key);
    if (cached) output[index] = cached;
    else uncached.push({ index, text: source });
  });

  const batches: typeof uncached[] = [];
  let batch: typeof uncached = [];
  let batchLength = 0;
  for (const item of uncached) {
    if (batch.length && batchLength + item.text.length + 1 > 1600) {
      batches.push(batch);
      batch = [];
      batchLength = 0;
    }
    batch.push(item);
    batchLength += item.text.length + 1;
  }
  if (batch.length) batches.push(batch);

  for (const group of batches) {
    const batch = group;
    const joined = batch.map((item) => item.text).join("\n");
    let translated = await translate(joined, body.language, "en-IN");
    let lines = translated.split(/\r?\n/).map((line) => line.trim());
    if (lines.length !== batch.length) {
      lines = await Promise.all(batch.map((item) => translate(item.text, body.language as string, "en-IN")));
    }
    batch.forEach((item, index) => {
      const value = lines[index] || item.text;
      output[item.index] = value;
      uiTranslationCache.set(`${body.language}\0${item.text}`, value);
    });
  }
  return c.json({ translations: output });
});

const ingestQueue: string[] = [];
let ingesting = false;

function pumpIngest(): void {
  if (ingesting) return;
  const id = ingestQueue.shift();
  if (!id) return;
  ingesting = true;
  ingestDocument(id)
    .catch((e) => {
      db.prepare(`UPDATE documents SET status='failed', error=?, updated_at=? WHERE id=?`).run(String(e?.message ?? e), now(), id);
    })
    .finally(() => {
      ingesting = false;
      pumpIngest();
    });
}

/* ---------------- health / stats ---------------- */

app.get("/api/health", async (c) => {
  const [sarvam, ollama] = await Promise.all([sarvamReachable(), ollamaReachable()]);
  return c.json({
    ok: true,
    sarvam,
    ollama,
    embeddings: embedStatus(),
    pending_jobs: pendingJobCount(),
    corpus: corpusStats(),
    embed_model: EMBED_MODEL,
  });
});

app.get("/api/stats", (c) => c.json({ ...corpusStats(), embeddings: embedStatus(), pending_jobs: pendingJobCount() }));

/* ---------------- upload ---------------- */

app.post("/api/upload", async (c) => {
  const body = c.req.raw.body;
  const ct = c.req.header("content-type") ?? "";
  if (!body || !ct.includes("multipart/form-data")) return c.json({ error: "multipart/form-data required" }, 400);

  const bb = Busboy({ headers: Object.fromEntries(c.req.raw.headers as any), limits: { fileSize: 200 * 1024 * 1024, files: 20 } });
  const saved: Array<{ id: string; filename: string; status: string; error?: string }> = [];
  const rejected: Array<{ filename: string; error: string }> = [];
  let privateFiles = false;
  const tasks: Promise<void>[] = [];

  await new Promise<void>((resolvePromise, rejectPromise) => {
    bb.on("field", (name, value) => {
      if (name === "private_files") privateFiles = value === "1";
    });
    bb.on("file", (_name, stream, info) => {
      if (!isSupportedUpload(info.filename)) {
        rejected.push({ filename: info.filename, error: "Unsupported file format" });
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      const limitHit = { v: false };
      stream.on("limit", () => (limitHit.v = true));
      stream.on("data", (d: Buffer) => chunks.push(d));
      stream.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (!buf.length) return;
        const stored = storeUpload(info.filename, buf);
        const id = createDoc({
          filename: stored.stored,
          stored: stored.stored,
          sha256: stored.sha256,
          mime: stored.mime,
          bytes: buf.length,
          privateFiles,
        });
        ingestQueue.push(id);
        tasks.push(Promise.resolve());
        saved.push({ id, filename: info.filename, status: limitHit.v ? "failed" : "queued", error: limitHit.v ? "file too large" : undefined });
      });
    });
    bb.on("finish", () => resolvePromise());
    bb.on("error", rejectPromise);
    Readable.fromWeb(body as never).pipe(bb);
  });

  pumpIngest();
  if (!saved.length && rejected.length) return c.json({ error: "Unsupported file format", rejected }, 415);
  return c.json({ documents: saved, rejected });
});

/* ---------------- documents ---------------- */

app.get("/api/documents", (c) => {
  const rows = db
    .prepare(
      `SELECT d.id, d.title, d.filename, d.mime, d.bytes, d.page_count, d.status, d.route, d.error, d.meta, d.private_files, d.created_at,
              (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunk_count,
              (SELECT COUNT(*) FROM pages p WHERE p.doc_id = d.id AND p.engine != 'pending-vision' AND (p.char_count > 0 OR p.engine='text-layer')) AS indexed_pages
       FROM documents d ORDER BY d.created_at DESC`,
    )
    .all() as any[];
  return c.json({ documents: rows.map((row) => ({
    ...row,
    private_files: row.private_files === 1,
  })) });
});

app.get("/api/documents/:id", (c) => {
  const id = c.req.param("id");
  const doc = db.prepare(`SELECT * FROM documents WHERE id=?`).get(id) as any;
  if (!doc) return c.json({ error: "not found" }, 404);
  const pages = db
    .prepare(`SELECT id, page_no, width, height, char_count, lang, quality, engine, render_path, quality_json FROM pages WHERE doc_id=? ORDER BY page_no`)
    .all(id) as any[];
  const chunks = db
    .prepare(`SELECT id, page_no, ord, kind, lang, section_path, substr(text,1,240) AS preview, token_est FROM chunks WHERE doc_id=? ORDER BY page_no, ord LIMIT 400`)
    .all(id) as any[];
  return c.json({
    document: { ...doc, meta: unj(doc.meta, {}) },
    pages: pages.map((p) => ({
      page_no: p.page_no,
      width: p.width,
      height: p.height,
      char_count: p.char_count,
      lang: p.lang,
      quality: p.quality,
      engine: p.engine,
      quality_json: unj<any>(p.quality_json, {}),
      has_render: !!p.render_path,
    })),
    chunks,
  });
});

app.delete("/api/documents/:id", (c) => {
  const id = c.req.param("id");
  dropDocumentIndex(id);
  db.prepare(`DELETE FROM documents WHERE id=?`).run(id);
  return c.json({ ok: true });
});

app.patch("/api/documents/:id", async (c) => {
  const id = c.req.param("id");
  const doc = db.prepare(`SELECT id FROM documents WHERE id=?`).get(id) as any;
  if (!doc) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { title?: unknown } | null;
  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 180) : "";
  if (!title) return c.json({ error: "title required" }, 400);
  db.prepare(`UPDATE documents SET title=?, updated_at=? WHERE id=?`).run(title, now(), id);
  return c.json({ ok: true, title });
});

app.get("/api/documents/:id/rerun", async (c) => {
  const id = c.req.param("id");
  const doc = db.prepare(`SELECT * FROM documents WHERE id=?`).get(id) as any;
  if (!doc) return c.json({ error: "not found" }, 404);
  ingestQueue.push(id);
  pumpIngest();
  return c.json({ ok: true, status: "queued" });
});

app.get("/api/documents/:id/render/:page", (c) => {
  const id = c.req.param("id");
  const page = Number(c.req.param("page"));
  try {
    const buf = readFileSync(renderPathFor(id, page));
    return new Response(new Uint8Array(buf), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
  } catch {
    return c.json({ error: "render missing on disk" }, 404);
  }
});

app.get("/api/documents/:id/page/:page/text", (c) => {
  const id = c.req.param("id");
  const page = Number(c.req.param("page"));
  const row = db.prepare(`SELECT text, lang, engine, char_count FROM pages WHERE doc_id=? AND page_no=?`).get(id, page) as any;
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

/* ---------------- ask ---------------- */

app.post("/api/ask", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const query = String(body.query ?? "").trim();
  if (!query) return c.json({ error: "query required" }, 400);
  const convId = body.conversation_id && db.prepare(`SELECT id FROM conversations WHERE id=?`).get(body.conversation_id) ? body.conversation_id : newConversation(query.slice(0, 60));

  const hist = history(convId, 10);
  addMessage(convId, "user", query);

  try {
    const result = await ask(query, hist, {
      topK: Number(body.top_k ?? 5),
      crossLingual: body.cross_lingual !== false,
      docId: body.document_id || undefined,
      verify: body.verify !== false,
    });
    if (result.conflicts.length) result.answer += `\n\n---\n**Conflicting sources detected**\n${conflictLines(result.conflicts)}`;
    addMessage(convId, "assistant", result.answer, {
      sources: result.sources,
      conflicts: result.conflicts,
      verdicts: result.verdicts,
      stats: result.stats,
      abstained: result.abstained,
    });
    return c.json({ conversation_id: convId, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addMessage(convId, "assistant", `Error: ${msg}`);
    return c.json({ conversation_id: convId, error: msg }, 500);
  }
});

/* ---------------- conversations ---------------- */

app.get("/api/conversations", (c) => c.json({ conversations: listConversations() }));
app.post("/api/conversations", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  return c.json({ conversation_id: newConversation(body.title ?? "New chat") });
});
app.delete("/api/conversations/:id", (c) => {
  const id = c.req.param("id");
  const result = db.prepare(`DELETE FROM conversations WHERE id=?`).run(id);
  if (!result.changes) return c.json({ error: "conversation not found" }, 404);
  return c.json({ ok: true });
});
app.get("/api/conversations/:id/messages", (c) => c.json({
  messages: listMessages(c.req.param("id")).map((message) => ({
    ...message,
    meta: typeof message.meta === "string" ? unj(message.meta, null) : message.meta,
  })),
}));

/* ---------------- debug: raw retrieval ---------------- */

app.post("/api/retrieve", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const { retrieve } = await import("./retrieval.js");
  const cands = await retrieve(String(body.query ?? ""), { topK: Number(body.top_k ?? 10), crossLingual: body.cross_lingual !== false });
  return c.json({ query: body.query, query_lang: heuristicLang(String(body.query ?? "")), results: cands });
});

/* ---------------- boot ---------------- */

app.get("/", (c) => c.json({ name: "docintel", docs: "/api/documents", ask: "/api/ask" }));

serve({ fetch: app.fetch, port: PORT, hostname: process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1" }, (info) => {
  console.log(`[docintel] api  http://localhost:${info.port}`);
  console.log(`[docintel] data ${RENDER_DIR}`);
  void initEmbeddings().then(() => console.log("[embeddings]", embedStatus().mode, embedStatus().model));
  startWorker();
  setInterval(pumpIngest, 1500);
  void basename;
});
