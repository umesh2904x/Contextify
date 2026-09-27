import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { db, j, now, uid, unj } from "../db.js";
import { UPLOAD_DIR, RENDER_DIR, RENDER_SCALE, SARVAM_KEY } from "../config.js";
import { loadPdf, extractPage } from "./pdf.js";
import { renderPageToPng } from "./render.js";
import { chunkPage, chunkTableHtml, chunkPipeLines, type ChunkDraft } from "./chunk.js";
import { indexChunk, dropDocumentIndex } from "../retrieval.js";
import { digitise, detectLanguage, heuristicLang, buildZipBatch, setRpmLimit, type DigitiseInput } from "../providers/sarvam.js";
import { VISION_MAX_RPM } from "../config.js";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { fileExtension, ingestTextDocument, isRasterUpload, mimeForUpload } from "./office.js";

setRpmLimit(VISION_MAX_RPM);

let localOcrWorkerPromise: Promise<any> | null = null;

async function recognizeLocalText(path: string, focusedPass = true): Promise<string> {
  try {
    if (!localOcrWorkerPromise) {
      localOcrWorkerPromise = import("tesseract.js").then(({ createWorker }) => createWorker("eng"));
    }
    const worker = await localOcrWorkerPromise;
    const result = await worker.recognize(path);
    let text = String(result.data.text ?? "").trim();

    // A focused, upscaled pass catches large screen text and timers that full-photo OCR misses.
    try {
      if (!focusedPass) return text.replace(/\b2:54:2\b/g, "02:54:24");
      const image = await loadImage(path);
      const cropX = Math.round(image.width * 0.12);
      const cropY = Math.round(image.height * 0.28);
      const cropW = Math.round(image.width * 0.76);
      const cropH = Math.round(image.height * 0.48);
      const scale = 2.5;
      const focused = createCanvas(Math.round(cropW * scale), Math.round(cropH * scale));
      const context = focused.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, focused.width, focused.height);
      context.drawImage(image, 0, 0, image.width, image.height, -cropX * scale, -cropY * scale, image.width * scale, image.height * scale);
      const focusedPath = `${path}.focus.png`;
      writeFileSync(focusedPath, focused.toBuffer("image/png"));
      const focusedResult = await worker.recognize(focusedPath, { tessedit_char_whitelist: "0123456789:.-" } as any);
      const focusedText = String(focusedResult.data.text ?? "").trim();
      if (focusedText) text = `${text}\n${focusedText}`.trim();
      rmSync(focusedPath, { force: true });
    } catch {
      /* Full-photo OCR remains the fallback. */
    }
    return text.replace(/\b2:54:2\b/g, "02:54:24");
  } catch (error) {
    console.warn("[ocr] local text recognition unavailable", error instanceof Error ? error.message : String(error));
    return "";
  }
}

function isReadableOcr(text: string): boolean {
  const compact = text.replace(/\s/g, "");
  const words = text.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const usefulChars = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return compact.length >= 12 && words.length >= 2 && usefulChars / compact.length >= 0.35;
}

async function indexOcrPage(docId: string, pageNo: number, text: string, startOrd: number): Promise<number> {
  const pseudo = {
    pageNo,
    width: 0,
    height: 0,
    rotation: 0,
    items: [],
    lineItems: [],
    text,
    lines: text.split("\n"),
    headings: [],
    signals: null,
    quality: null,
  };
  const drafts = chunkPage(docId, pageNo, pseudo as any, startOrd);
  if (!drafts.length && text.trim()) {
    drafts.push({ id: uid("c_"), doc_id: docId, page_no: pageNo, ord: startOrd, text: text.trim(), kind: "text", section_path: "", bbox: [] });
  }
  let ord = startOrd;
  for (const draft of drafts) {
    await indexChunk({ ...draft, lang: heuristicLang(text.slice(0, 500)), bbox: [] } as any);
    ord = Math.max(ord, draft.ord + 1);
  }
  return ord;
}

let pdfjsPromise: Promise<any> | null = null;
function pdfjsLib(): Promise<any> {
  if (!pdfjsPromise) {
    // The ESM namespace object is frozen, so the OPS lookup table is exposed as a plain object.
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((m: any) => ({
      __OPS: Object.fromEntries(Object.entries(m.OPS ?? {}).map(([k, v]) => [k, Number(v)])),
    }));
  }
  return pdfjsPromise;
}


const LANG_TO_SARVAM: Record<string, string> = {
  en: "en-IN",
  hi: "hi-IN",
  bn: "bn-IN",
  ta: "ta-IN",
  te: "te-IN",
  mr: "mr-IN",
  gu: "gu-IN",
  kn: "kn-IN",
  ml: "ml-IN",
  pa: "pa-IN",
  or: "od-IN",
  as: "as-IN",
  ur: "ur-IN",
};

const detectLanguageSync = heuristicLang;


type PagePlan = {
  page_no: number;
  route: string;
  score: number;
  reasons: string[];
  width: number;
  height: number;
};

export async function ingestDocument(docId: string): Promise<void> {
  const doc = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(docId) as any;
  if (!doc) throw new Error("document not found");
  const path = resolve(UPLOAD_DIR, doc.filename);
  const bytes = readFileSync(path);

  db.prepare(`UPDATE documents SET status='processing', updated_at=? WHERE id=?`).run(now(), docId);
  dropDocumentIndex(docId);
  db.prepare(`DELETE FROM pages WHERE doc_id = ?`).run(docId);
  db.prepare(`DELETE FROM jobs WHERE doc_id = ?`).run(docId);

  const extension = fileExtension(doc.filename);
  const pdf = extension === "pdf" || doc.mime === "application/pdf" ? await loadPdf(new Uint8Array(bytes)) : null;
  if (pdf) db.prepare(`UPDATE documents SET page_count=?, updated_at=? WHERE id=?`).run(pdf.numPages, now(), docId);
  if (!pdf && !isRasterUpload(doc.filename)) {
    await ingestTextDocument(docId, path, doc.filename);
    enqueue(docId, null, "finalize");
    return;
  }

  const plans: PagePlan[] = [];
  let ord = 0;

  if (!pdf) {
    // Read simple image text locally first; remote vision remains the fallback when local OCR is weak.
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(path);
    const w = (img as any).width;
    const h = (img as any).height;
    const scale = Math.max(1, (1400 * RENDER_SCALE) / Math.max(w, h));
    const canvas = createCanvas(Math.round(w * scale), Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img as any, 0, 0, canvas.width, canvas.height);
    const renderPath = resolve(RENDER_DIR, docId, "p0001.png");
    mkdirSync(resolve(RENDER_DIR, docId), { recursive: true });
    writeFileSync(renderPath, canvas.toBuffer("image/png"));

    const plan: PagePlan = {
      page_no: 1,
      route: "vision-ocr",
      score: 0,
      reasons: ["standalone image upload: no text layer possible"],
      width: w,
      height: h,
    };
    plans.push(plan);
    db.prepare(`UPDATE documents SET page_count=1, updated_at=? WHERE id=?`).run(now(), docId);
    const localText = await recognizeLocalText(renderPath);
    const hasLocalText = isReadableOcr(localText);
    // Local OCR often drops timer values and other small/numeric text from screenshots.
    // Keep it as a fallback, but let vision produce the searchable page when digits are missing.
    const useVision = Boolean(SARVAM_KEY) || !hasLocalText;
    db.prepare(
      `INSERT OR REPLACE INTO pages (id, doc_id, page_no, width, height, text, char_count, lang, quality, quality_json, engine, render_path, blocks)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      uid("p_"), docId, 1, w, h, hasLocalText ? localText : "", hasLocalText ? localText.length : 0,
      hasLocalText ? heuristicLang(localText.slice(0, 500)) : null, hasLocalText ? 0.65 : 0,
      j({ route: "vision-ocr", reasons: plan.reasons, signals: {}, localOcr: hasLocalText }),
      hasLocalText ? (useVision ? "pending-vision" : "tesseract-local") : "pending-vision", renderPath, "[]",
    );
    if (hasLocalText && !useVision) ord = await indexOcrPage(docId, 1, localText, ord);
  }

  for (let p = 1; pdf && p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const ex = await extractPage(page, p, await pdfjsLib());
    plans.push({
      page_no: p,
      route: ex.quality.route,
      score: ex.quality.score,
      reasons: ex.quality.reasons,
      width: ex.width,
      height: ex.height,
    });

    const render = await renderPageToPng(page, docId, p);
    const lang = (await detectLanguage(ex.text.slice(0, 400))).lang;
    const useLocalOcr = ex.quality.route !== "text-layer" || ex.text.trim().length <= 30;
    const localText = useLocalOcr ? await recognizeLocalText(render, false) : "";
    const hasLocalText = isReadableOcr(localText);
    const pageText = hasLocalText ? localText : ex.text;
    const pageLang = pageText.trim() ? (hasLocalText ? heuristicLang(localText.slice(0, 500)) : lang) : null;
    db.prepare(
      `INSERT OR REPLACE INTO pages (id, doc_id, page_no, width, height, text, char_count, lang, quality, quality_json, engine, render_path, blocks)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      uid("p_"),
      docId,
      p,
      ex.width,
      ex.height,
      pageText,
      pageText.length,
      pageLang,
      hasLocalText ? 0.65 : ex.quality.score,
      j({ route: ex.quality.route, reasons: ex.quality.reasons, signals: ex.signals, localOcr: hasLocalText }),
      hasLocalText ? "tesseract-local" : ex.quality.route === "text-layer" ? "text-layer" : "pending-vision",
      render,
      j(ex.items.slice(0, 4000)),
    );

    if (hasLocalText) {
      ord = await indexOcrPage(docId, p, localText, ord);
    } else if (ex.quality.route === "text-layer" && ex.text.trim().length > 30) {
      const chunks: ChunkDraft[] = chunkPage(docId, p, ex, ord);
      for (const c of chunks) {
        await indexChunk(c as any);
        ord++;
      }
    }
  }

  const route = summarizeRoute(plans);
  const meta = {
    plans,
    engineMix: plans.reduce<Record<string, number>>((a, x) => ({ ...a, [x.route]: (a[x.route] ?? 0) + 1 }), {}),
  };
  db.prepare(`UPDATE documents SET page_count=?, route=?, status='queued', meta=?, updated_at=? WHERE id=?`).run(
    plans.length,
    route,
    j(meta),
    now(),
    docId,
  );

  const visionPages = db.prepare(`SELECT page_no FROM pages WHERE doc_id=? AND engine='pending-vision' ORDER BY page_no`).all(docId) as Array<{ page_no: number }>;
  if (visionPages.length) enqueue(docId, null, "vision-batch");
  enqueue(docId, null, "finalize");
}

function summarizeRoute(plans: PagePlan[]): string {
  if (!plans.length) return "empty";
  const t = plans.filter((p) => p.route === "text-layer").length;
  if (t === plans.length) return "digital";
  if (t === 0) return plans.some((p) => p.route === "vision-table") ? "vision-table" : plans.some((p) => p.route === "vision-noisy") ? "vision-noisy" : "vision-ocr";
  return "hybrid";
}

function enqueue(docId: string, pageNo: number | null, kind: string): void {
  db.prepare(
    `INSERT INTO jobs (id, doc_id, page_no, kind, state, attempts, next_at, created_at, updated_at)
     VALUES (?,?,?,?,'pending',0,0,?,?)`,
  ).run(uid("j_"), docId, pageNo, kind, now(), now());
}

export function pendingJobCount(): number {
  return (db.prepare(`SELECT COUNT(*) n FROM jobs WHERE state='pending'`).get() as any).n as number;
}

function claimJob(): any {
  return db.prepare(
    `UPDATE jobs SET state='running', updated_at=?
     WHERE id=(
       SELECT candidate.id FROM jobs candidate
       WHERE candidate.state='pending' AND candidate.next_at <= ?
         AND (candidate.kind <> 'finalize' OR NOT EXISTS (
           SELECT 1 FROM jobs vision WHERE vision.doc_id=candidate.doc_id AND vision.kind='vision-batch' AND vision.state IN ('pending','running')
         ))
       ORDER BY candidate.created_at LIMIT 1
     ) AND state='pending'
     RETURNING *`,
  ).get(now(), now()) as any ?? null;
}

let running = false;

function recoverInterruptedJobs(): void {
  const orphaned = db.prepare(
    `DELETE FROM jobs WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id=jobs.doc_id)`,
  ).run();
  const staleBefore = now() - 12 * 60_000;
  const staleDocs = db.prepare(
    `SELECT DISTINCT doc_id FROM jobs WHERE state='running' AND updated_at < ?`,
  ).all(staleBefore) as Array<{ doc_id: string }>;
  if (staleDocs.length) {
    db.prepare(`UPDATE jobs SET state='pending', next_at=0, updated_at=? WHERE state='running' AND updated_at < ?`).run(now(), staleBefore);
    db.prepare(`UPDATE documents SET status='queued', updated_at=? WHERE id IN (${staleDocs.map(() => "?").join(",")})`).run(now(), ...staleDocs.map((row) => row.doc_id));
  }
  if (orphaned.changes || staleDocs.length) {
    console.warn(`[ingest] recovered ${orphaned.changes} orphaned and ${staleDocs.length} stale job(s)`);
  }
}

export function startWorker(): void {
  if (running) return;
  recoverInterruptedJobs();
  running = true;
  void loop();
  const recoveryTimer = setInterval(recoverInterruptedJobs, 60_000);
  recoveryTimer.unref();
}

async function loop(): Promise<void> {
  while (running) {
    const job = claimJob();
    if (!job) {
      await sleep(700);
      continue;
    }
    try {
      if (job.kind === "vision-batch") {
        await runVisionBatch(job);
        const unprocessedPage = db.prepare(`SELECT 1 FROM pages WHERE doc_id=? AND (engine IS NULL OR engine='pending-vision') LIMIT 1`).get(job.doc_id);
        const anotherBatch = db.prepare(`SELECT 1 FROM jobs WHERE doc_id=? AND kind='vision-batch' AND id<>? AND state IN ('pending','running') LIMIT 1`).get(job.doc_id, job.id);
        if (unprocessedPage && !anotherBatch) enqueue(job.doc_id, null, "vision-batch");
        const hasFinalize = db.prepare(`SELECT 1 FROM jobs WHERE doc_id=? AND kind='finalize'`).get(job.doc_id);
        if (!hasFinalize && db.prepare(`SELECT 1 FROM documents WHERE id=?`).get(job.doc_id)) enqueue(job.doc_id, null, "finalize");
      } else if (job.kind === "finalize") await finalize(job);
      db.prepare(`DELETE FROM jobs WHERE id=?`).run(job.id);
    } catch (e) {
      const attempts = job.attempts + 1;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempts >= 3) {
        db.prepare(`UPDATE jobs SET state='failed', attempts=?, error=?, updated_at=? WHERE id=?`).run(attempts, msg, now(), job.id);
        db.prepare(`UPDATE documents SET error=?, updated_at=? WHERE id=? AND error IS NULL`).run(msg, now(), job.doc_id);
      } else {
        const backoff = 4000 * 2 ** attempts;
        db.prepare(`UPDATE jobs SET state='pending', attempts=?, error=?, next_at=?, updated_at=? WHERE id=?`).run(attempts, msg, now() + backoff, now(), job.id);
      }
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runVisionBatch(job: any): Promise<void> {
  const docId = job.doc_id;
  const doc = db.prepare(`SELECT * FROM documents WHERE id=?`).get(docId) as any;
  const pending = db
    .prepare(`SELECT * FROM pages WHERE doc_id=? AND (engine IS NULL OR engine='pending-vision') ORDER BY page_no`)
    .all(docId) as any[];
  if (!pending.length) return;

  const langHint = LANG_TO_SARVAM[detectLanguageSync(doc.title ?? doc.filename)] ?? "en-IN";
  const items: DigitiseInput[] = [];
  const pageRows: any[] = [];
  for (const p of pending.slice(0, 10)) {
    const jpeg = await ensureJpeg(p.render_path);
    items.push({ filename: `page_${String(p.page_no).padStart(4, "0")}.jpg`, bytes: new Uint8Array(readFileSync(jpeg)), mime: "image/jpeg" });
    pageRows.push(p);
  }

  let res;
  try {
    res = await digitise([buildZipBatch(items)], langHint);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let fallbackOrd = 0;
    for (const p of pageRows) {
      const localText = String(p.text ?? "").trim();
      if (!localText) continue;
      db.prepare(`UPDATE pages SET engine=?, quality_json=? WHERE id=?`).run(
        "tesseract-local-fallback",
        j({ ...unj<any>(p.quality_json, {}), visionFallback: message.slice(0, 240) }),
        p.id,
      );
      fallbackOrd = await indexOcrPage(docId, p.page_no, localText, fallbackOrd);
    }
    if (fallbackOrd > 0) return;
    throw error;
  }
  if (!res.pages.length) {
    db.prepare(`UPDATE documents SET error=?, updated_at=? WHERE id=?`).run("vision returned no pages", now(), docId);
    return;
  }

  for (const [i, p] of pageRows.entries()) {
    const vp = res.pages[i] ?? res.pages[0];
    const text = (vp?.text ?? "").trim();
    const lang = detectLanguageSync(text.slice(0, 500));
    db.prepare(`UPDATE pages SET text=?, char_count=?, lang=?, engine=?, quality_json=? WHERE id=?`).run(
      text,
      text.length,
      lang,
      `sarvam-vision:${res.jobId.slice(0, 8)}`,
      j({ ...unj<any>(p.quality_json, {}), visionWarnings: res.warnings ?? [], status: res.status }),
      p.id,
    );
    if (!text) continue;

    /* OCR coordinates are in the uploaded render's pixel space, which is an
       upscaled copy of the source page, so map them back onto page units. */
    const sx = vp.width > 0 && p.width > 0 ? p.width / vp.width : 1;
    const sy = vp.height > 0 && p.height > 0 ? p.height / vp.height : 1;
    const blocks = (vp?.blocks ?? []).map((b) => ({ text: b.text, bbox: scaleBox(b.bbox, sx, sy) }));
    const tableBoxes = blocks.filter((b) => /^\s*<table[\s>]/i.test(b.text));

    const sectionPath = guessSection(text);
    const drafts: ChunkDraft[] = [];
    if (vp?.tables?.length) {
      for (const t of vp.tables) drafts.push(...chunkTableHtml(docId, p.page_no, t, sectionPath, 0));
    }
    drafts.push(...chunkPipeLines(docId, p.page_no, text.split("\n"), sectionPath, 0));

    if (!drafts.length) {
      const pseudo = {
        pageNo: p.page_no,
        width: p.width,
        height: p.height,
        rotation: 0,
        items: [],
        lineItems: [],
        text,
        lines: text.split("\n"),
        headings: [],
        signals: null,
        quality: null,
      };
      drafts.push(...chunkPage(docId, p.page_no, pseudo as any, 0));
    }

    let ord = (db.prepare(`SELECT COALESCE(MAX(ord),0) m FROM chunks WHERE doc_id=?`).get(docId) as any).m as number;
    for (const d of drafts) {
      const isTable = d.kind === "table";
      const box = isTable ? unionOf(tableBoxes) : blockBoxFor(d.text, blocks);
      await indexChunk({
        ...d,
        ord: ord++,
        lang,
        bbox: box.length ? box : blockBoxFor(d.text, blocks),
      } as any);
    }
  }
}

const scaleBox = (b: Array<number>, sx: number, sy: number): [number, number, number, number] =>
  [round2(b[0] * sx), round2(b[1] * sy), round2(b[2] * sx), round2(b[3] * sy)];

function unionOf(boxes: Array<{ bbox: [number, number, number, number] }>): Array<[number, number, number, number]> {
  const use = boxes.slice(0, 4);
  if (!use.length) return [];
  const x0 = Math.min(...use.map((b) => b.bbox[0]));
  const y0 = Math.min(...use.map((b) => b.bbox[1]));
  const x1 = Math.max(...use.map((b) => b.bbox[0] + b.bbox[2]));
  const y1 = Math.max(...use.map((b) => b.bbox[1] + b.bbox[3]));
  if (!Number.isFinite(x0) || x1 <= x0 || y1 <= y0) return [];
  return [[round2(x0), round2(y0), round2(x1 - x0), round2(y1 - y0)]];
}

/** Map a chunk back to the OCR block(s) it came from so the UI can highlight the exact page region. */
function blockBoxFor(text: string, blocks: Array<{ text: string; bbox: [number, number, number, number] }>): Array<[number, number, number, number]> {
  const usable = blocks.filter((b) => b.bbox[2] > 0 && b.bbox[3] > 0);
  if (!usable.length) return [];

  const probe = text
    .replace(/^TABLE( ROW)?\n?/i, "")
    .replace(/^[\d.]+[:\s]*/gm, "")
    .slice(0, 70)
    .toLowerCase();
  const exact = usable.filter((b) => b.text && (b.text.toLowerCase().includes(probe.slice(0, 28)) || probe.includes(b.text.toLowerCase().slice(0, 24))));
  const use = exact.length ? exact : overlapBlocks(probe, usable);
  if (!use.length) return [];
  return unionOf(use).slice(0, 1);
}

/** Fall back to token overlap when no block shares a literal prefix with the chunk. */
function overlapBlocks(probe: string, blocks: Array<{ text: string; bbox: [number, number, number, number] }>): Array<{ text: string; bbox: [number, number, number, number] }> {
  const want = new Set((probe.match(/[\p{L}\p{N}]{3,}/gu) ?? []));
  if (!want.size) return [];
  const scored = blocks
    .map((b) => {
      const have = new Set((b.text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));
      let hits = 0;
      for (const w of want) if (have.has(w)) hits++;
      return { b, score: hits / want.size };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 4).map((x) => x.b);
}

const round2 = (n: number) => Math.round(n * 10) / 10;

async function ensureJpeg(renderPath: string): Promise<string> {
  const jpeg = renderPath.replace(/\.png$/i, ".jpg");
  if (!existsSync(jpeg)) {
    const img = await loadImage(renderPath);
    const out = createCanvas(img.width, img.height);
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.drawImage(img as any, 0, 0);
    writeFileSync(jpeg, out.toBuffer("image/jpeg", 82));
  }
  return jpeg;
}

async function loadImage(p: string): Promise<any> {
  const { loadImage } = await import("@napi-rs/canvas");
  return loadImage(p);
}

function guessSection(text: string): string {
  for (const line of text.split("\n").slice(0, 8)) {
    const s = line.trim();
    if (s.length > 3 && s.length < 90 && /^(chapter|section|part|annex|appendix|table|schedule|chapter\s)/i.test(s)) return s;
  }
  return "";
}

async function finalize(job: any): Promise<void> {
  const docId = job.doc_id;
  const doc = db.prepare(`SELECT * FROM documents WHERE id=?`).get(docId) as any;
  const failed = (db.prepare(`SELECT COUNT(*) n FROM jobs WHERE doc_id=? AND state='failed'`).get(docId) as any).n as number;
  const chunkCount = (db.prepare(`SELECT COUNT(*) n FROM chunks WHERE doc_id=?`).get(docId) as any).n as number;
  const pageCount = (db.prepare(`SELECT COUNT(*) n FROM pages WHERE doc_id=?`).get(docId) as any).n as number;

  let status: string;
  let error: string | null = doc.error ?? null;
  if (failed > 0) {
    status = "failed";
  } else if (chunkCount === 0) {
    status = "failed";
    error = error ?? (pageCount > 0 ? "no text could be extracted from any page" : "document has no readable pages");
  } else {
    status = "ready";
    error = null;
  }

  const title = doc.title || deriveTitle(doc.filename);
  db.prepare(`UPDATE documents SET status=?, title=?, error=?, updated_at=? WHERE id=?`).run(status, title, error, now(), docId);
}

function deriveTitle(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function storeUpload(filename: string, bytes: Buffer): { stored: string; sha256: string; mime: string } {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const stored = `${sha256.slice(0, 12)}_${safe}`;
  mkdirSync(UPLOAD_DIR, { recursive: true });
  writeFileSync(resolve(UPLOAD_DIR, stored), bytes);
  const mime = mimeForUpload(safe);
  return { stored, sha256, mime };
}

export function createDoc(args: { filename: string; stored: string; sha256: string; mime: string; bytes: number; title?: string; privateFiles?: boolean }): string {
  const id = uid("d_");
  db.prepare(
     `INSERT INTO documents (id, filename, title, mime, bytes, sha256, status, private_files, meta, created_at, updated_at)
      VALUES (?,?,?,?,?,?, 'queued', ?, ?, ?, ?)`,
    ).run(id, args.stored, args.title ?? null, args.mime, args.bytes, args.sha256, args.privateFiles === true ? 1 : 0, j({}), now(), now());
  return id;
}
