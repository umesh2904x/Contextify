import { createRequire } from "node:module";
import https from "node:https";
import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  SARVAM_KEY,
  SARVAM_BASE,
  SARVAM_TEXT_MODEL,
  SARVAM_LID_MODEL,
  SARVAM_TRANSLATE_MODEL,
  SARVAM_VISION_MODEL,
  GROQ_API_KEY,
  GROQ_MODEL,
  XAI_API_KEY,
  XAI_MODEL,
  OLLAMA_HOST,
  OLLAMA_MODEL,
} from "../config.js";

const require = createRequire(import.meta.url);
const TMP_DIR = resolve(process.cwd(), "data");

export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

let rpmWindow: number[] = [];
let rpmLimit = 12;

export function setRpmLimit(n: number): void {
  rpmLimit = Math.max(1, n);
}

async function throttle(): Promise<void> {
  const cutoff = Date.now() - 60_000;
  rpmWindow = rpmWindow.filter((t) => t > cutoff);
  while (rpmWindow.length >= rpmLimit) {
    await new Promise((r) => setTimeout(r, 1200));
    rpmWindow = rpmWindow.filter((t) => t > Date.now() - 60_000);
  }
  rpmWindow.push(Date.now());
}

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}, attempt = 0, maxRetries = 5, timeoutMs?: number): Promise<any> {
  await throttle();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxRetries) {
      const wait = Math.min(30_000, 1500 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, wait));
      return post(url, body, headers, attempt + 1, maxRetries, timeoutMs);
    }
    throw new ProviderError(`${res.status} ${text.slice(0, 400)}`, res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`non-JSON response: ${text.slice(0, 200)}`, res.status);
  }
}

function sarvamHeaders(): Record<string, string> {
  if (!SARVAM_KEY) throw new ProviderError("SARVAM_API_KEY missing");
  return { "api-subscription-key": SARVAM_KEY };
}

/* ---------------- chat ---------------- */

export type ChatResult = { text: string; provider: string; model: string };

export async function chat(
  messages: ChatMsg[],
  opts: { temperature?: number; maxTokens?: number; json?: boolean; reason?: boolean; prefer?: "sarvam" | "groq" | "ollama" } = {},
): Promise<ChatResult> {
  const providers = opts.prefer === "ollama"
    ? ["ollama"]
    : opts.prefer === "groq"
      ? ["groq", "sarvam", "ollama"]
      : ["xai", "sarvam", "groq", "ollama"];
  let lastError: unknown;

  for (const provider of providers) {
    if (provider === "xai" && XAI_API_KEY) {
      try {
        const result = await xaiChat(messages, opts);
        if (result.text) return result;
      } catch (error) {
        lastError = error;
      }
    } else if (provider === "sarvam" && SARVAM_KEY) {
      try {
      const body: Record<string, unknown> = {
        model: SARVAM_TEXT_MODEL,
        messages,
        max_tokens: opts.maxTokens ?? 4096,
        stream: false,
        reasoning_effort: opts.reason ? "low" : null,
      };
      if (opts.temperature != null) body.temperature = opts.temperature;
      if (opts.json) body.response_format = { type: "json_object" };
      const r = await post(`${SARVAM_BASE}/v1/chat/completions`, body, sarvamHeaders(), 0, 0, 10_000);
      const text = r?.choices?.[0]?.message?.content ?? "";
      if (typeof text === "string" && text.trim()) {
        return { text: text.trim(), provider: "sarvam", model: SARVAM_TEXT_MODEL };
      }
        throw new ProviderError("empty completion (likely max_tokens consumed by reasoning)", 502);
      } catch (error) {
        lastError = error;
      }
    } else if (provider === "groq" && GROQ_API_KEY) {
      try {
        const result = await groqChat(messages, opts);
        if (result.text) return result;
      } catch (error) {
        lastError = error;
      }
    } else if (provider === "ollama") {
      try {
        return await ollamaChat(messages, opts);
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new ProviderError("No AI provider is available");
}

async function groqChat(messages: ChatMsg[], opts: { temperature?: number; maxTokens?: number; json?: boolean } = {}): Promise<ChatResult> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: opts.temperature ?? 0.1,
      max_tokens: opts.maxTokens ?? 1500,
      response_format: opts.json ? { type: "json_object" } : undefined,
      stream: false,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new ProviderError(`groq ${res.status}`, res.status);
  const r = await res.json();
  const text = r?.choices?.[0]?.message?.content ?? "";
  return { text: String(text).trim(), provider: "groq", model: GROQ_MODEL };
}

async function xaiChat(messages: ChatMsg[], opts: { temperature?: number; maxTokens?: number; json?: boolean } = {}): Promise<ChatResult> {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${XAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: XAI_MODEL,
      messages,
      temperature: opts.temperature ?? 0.1,
      max_tokens: opts.maxTokens ?? 1500,
      response_format: opts.json ? { type: "json_object" } : undefined,
      stream: false,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new ProviderError(`xAI ${res.status}`, res.status);
  const result = await res.json();
  const text = result?.choices?.[0]?.message?.content ?? "";
  return { text: String(text).trim(), provider: "xai", model: XAI_MODEL };
}

async function ollamaChat(messages: ChatMsg[], opts: { temperature?: number; maxTokens?: number; json?: boolean } = {}): Promise<ChatResult> {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: false,
      format: opts.json ? "json" : undefined,
      options: { temperature: opts.temperature ?? 0.1, num_predict: opts.maxTokens ?? 1400 },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new ProviderError(`ollama ${res.status}`, res.status);
  const r = await res.json();
  const text = r?.message?.content ?? "";
  return { text: String(text).trim(), provider: "ollama", model: OLLAMA_MODEL };
}

export async function sarvamReachable(): Promise<boolean> {
  if (!SARVAM_KEY) return false;
  try {
    const res = await fetch(`${SARVAM_BASE}/v1/models`, { headers: sarvamHeaders() });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

/* ---------------- language id ---------------- */

const LID_CACHE = new Map<string, string>();

export async function detectLanguage(text: string): Promise<{ lang: string; script: string; confidence: number }> {
  const sample = text.slice(0, 400);
  if (LID_CACHE.has(sample)) {
    const c = LID_CACHE.get(sample)!;
    return { lang: c, script: scriptOf(c), confidence: 1 };
  }
  if (SARVAM_KEY) {
    try {
      const r = await post(`${SARVAM_BASE}/v1/lid`, { input: [{ text: sample }] }, sarvamHeaders());
      const item = r?.results?.[0];
      const detected = r?.inferred_language ?? item?.detected_language;
      if (detected) {
        LID_CACHE.set(sample, detected);
        return { lang: detected, script: scriptOf(detected), confidence: Number(item?.confidence ?? 1) };
      }
    } catch {
      /* fall through to heuristic */
    }
  }
  const lang = heuristicLang(sample);
  LID_CACHE.set(sample, lang);
  return { lang, script: scriptOf(lang), confidence: 0.4 };
}

const SCRIPT_RANGES: Array<[RegExp, string]> = [
  [/[ऀ-ॿ]/, "Devanagari"],
  [/[ঀ-৿]/, "Bengali"],
  [/[஀-௿]/, "Tamil"],
  [/[ఀ-౿]/, "Telugu"],
  [/[ಀ-೿]/, "Kannada"],
  [/[ഀ-ൿ]/, "Malayalam"],
  [/[઀-૿]/, "Gujarati"],
  [/[଀-୿]/, "Oriya"],
  [/[ର-ୱ]/, "Assamese"],
  [/[ऀ-ॿঀ-৿]/, "Indic"],
];

export function scriptOf(lang: string): string {
  for (const [re, name] of SCRIPT_RANGES) {
    if (name === "Indic") continue;
    if (re.test(lang)) return name;
  }
  return "Latin";
}

const HINT: Array<[RegExp, string]> = [
  [/[ऀ-ॿ]/, "hi"],
  [/[ঀ-৿]/, "bn"],
  [/[஀-௿]/, "ta"],
  [/[ఀ-౿]/, "te"],
  [/[ಀ-೿]/, "kn"],
  [/[ഀ-ൿ]/, "ml"],
  [/[઀-૿]/, "gu"],
  [/[଀-୿]/, "or"],
  [/[ର-ୱ]/, "as"],
  [/[؀-ۿ]/, "ar"],
  [/[ऀ-ॿ]/, "mr"],
];

export function heuristicLang(text: string): string {
  for (const [re, lang] of HINT) {
    const m = text.match(new RegExp(re.source, "g"));
    if (m && m.length >= 2) return lang;
  }
  const dev = (text.match(/[ऀ-ॿ]/g) ?? []).length;
  if (dev > 0) return "hi";
  return "en";
}

/* ---------------- translate ---------------- */

export async function translate(text: string, target: string, source?: string): Promise<string> {
  if (target === source) return text;
  if (SARVAM_KEY) {
    try {
      const r = await post(
        `${SARVAM_BASE}/translate`,
        { input: text, model: SARVAM_TRANSLATE_MODEL, source_language_code: source, target_language_code: target },
        sarvamHeaders(),
      );
      const translated = String(r?.translated_text ?? "").trim();
      if (translated && translated !== text) return translated;
    } catch {
      /* Fall back to the local Ollama model when Sarvam is unavailable or out of credit. */
    }
  }
  try {
    const local = await chat(
      [
        { role: "system", content: `Translate the input from ${source ?? "English"} to ${target}. Preserve meaning and line breaks. Return only the translation.` },
        { role: "user", content: text },
      ],
      { prefer: "ollama", maxTokens: Math.max(120, text.length * 2), temperature: 0 },
    );
    return local.text.trim() || text;
  } catch {
    return text;
  }
}

/* ---------------- document ai (sarvam vision) ---------------- */

export type VisionBlock = { text: string; tag?: string; bbox: [number, number, number, number] };
export type VisionPage = {
  page_no: number;
  text: string;
  tables: string[];
  blocks: VisionBlock[];
  md?: string;
  /** Pixel dimensions of the image the OCR coordinates refer to. */
  width: number;
  height: number;
};
export type VisionResult = { pages: VisionPage[]; jobId: string; status: string; warnings: string[] };

const DOC_AI = `${SARVAM_BASE}/doc-ai/v1/job`;

async function docAiFetch(path: string, init?: RequestInit, attempt = 0): Promise<Response> {
  await throttle();
  const res = await fetch(`${DOC_AI}${path}`, {
    ...init,
    headers: { "api-subscription-key": SARVAM_KEY, ...(init?.headers ?? {}) },
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 6) {
      const wait = Math.min(45_000, 3000 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, wait));
      return docAiFetch(path, init, attempt + 1);
    }
  }
  return res;
}

const TERMINAL = new Set(["completed", "partially_completed", "failed", "rejected"]);

export type DigitiseInput = { filename: string; bytes: Uint8Array; mime: string };

export async function digitise(items: DigitiseInput[], language = "en-IN"): Promise<VisionResult> {
  if (!SARVAM_KEY) throw new ProviderError("SARVAM_API_KEY missing");
  if (items.length === 0) return { pages: [], jobId: "", status: "empty", warnings: ["no input"] };
  if (items.length > 10) throw new ProviderError("max 10 pages per job");

  const form = new FormData();
  const primary = items[0];
  form.append("file", new Blob([primary.bytes as unknown as BlobPart], { type: primary.mime }), primary.filename);
  form.append("language", language);
  form.append("output_format", "json");

  const create = await docAiFetch("/digitise", { method: "POST", body: form });
  const ctext = await create.text();
  if (!create.ok) throw new ProviderError(`digitise ${create.status}: ${ctext.slice(0, 300)}`, create.status);
  const jobId: string = JSON.parse(ctext).job_id;
  if (!jobId) throw new ProviderError(`digitise: no job_id (${ctext.slice(0, 200)})`);

  let status = "pending";
  let usage: any = null;
  const deadline = Date.now() + 8 * 60_000;
  let delay = 2000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(10_000, Math.round(delay * 1.35));
    const sres = await docAiFetch(`/${jobId}/status`);
    if (!sres.ok) continue;
    const s: any = await sres.json();
    status = String(s.status ?? "").toLowerCase();
    usage = s.usage ?? null;
    if (TERMINAL.has(status)) break;
  }
  if (!TERMINAL.has(status)) throw new ProviderError(`digitise job timeout (${status})`, 504);
  if (status === "failed" || status === "rejected") throw new ProviderError(`digitise job ${status}`, 422);

  const warnings: string[] = [];
  if (status === "partially_completed") warnings.push("partially completed: some pages failed");
  if (usage?.pages_failed) warnings.push(`${usage.pages_failed}/${usage.pages_total} pages failed`);

  const dl = await docAiFetch(`/${jobId}/download-url`);
  if (!dl.ok) throw new ProviderError(`download-url ${dl.status}`, dl.status);
  const { url, method } = (await dl.json()) as { url: string; method?: string };
  const zipBuf = await downloadBlob(url, method ?? "GET");

  return { ...parseZip(zipBuf, warnings), jobId, status, warnings };
}

/**
 * Azure Blob rejects undici's fetch from some networks, so fall back through
 * node:https and finally curl.exe (always present on Windows).
 */
async function downloadBlob(url: string, method: string): Promise<Buffer> {
  const attempts: Array<() => Promise<Buffer>> = [
    async () => {
      const r = await fetch(url, { method });
      if (!r.ok) throw new Error(`http ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async () => {
      const bin = await new Promise<string>((resolve, reject) => {
        const req = https.request(url, { method, headers: { "api-subscription-key": SARVAM_KEY } }, (res) => {
          if ((res.statusCode ?? 0) >= 400) return reject(new Error(`http ${res.statusCode}`));
          const parts: Buffer[] = [];
          res.on("data", (c: Buffer) => parts.push(c));
          res.on("end", () => resolve(Buffer.concat(parts).toString("base64")));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(120000, () => req.destroy(new Error("timeout")));
        req.end();
      });
      return Buffer.from(bin, "base64");
    },
    async () => {
      const tmp = resolve(TMP_DIR, `sarvam-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
      await new Promise<void>((res, rej) => {
        execFile("curl.exe", ["-sSL", "--max-time", "120", "-H", `api-subscription-key: ${SARVAM_KEY}`, "-o", tmp, url], (e) => (e ? rej(e) : res()));
      });
      const buf = readFileSync(tmp);
      rmSync(tmp, { force: true });
      if (buf.length < 100) throw new Error("empty download");
      return buf;
    },
  ];

  const errs: string[] = [];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (e) {
      errs.push(String(e).slice(0, 120));
    }
  }
  throw new ProviderError(`zip download failed: ${errs.join(" | ")}`);
}

function parseZip(buf: Buffer, warnings: string[]): { pages: VisionPage[]; warnings: string[] } {
  const AdmZip = require("adm-zip") as typeof import("adm-zip");
  const zip = new AdmZip(buf);
  const entries = zip.getEntries().filter((e: any) => !e.isDirectory);
  const names = entries.map((e: any) => e.entryName);

  readManifest(zip, entries, warnings);

  const pages: VisionPage[] = [];
  const jsonNames = names.filter((n: string) => /\.json$/i.test(n) && !/manifest/i.test(n));

  const pageFiles = jsonNames
    .filter((n: string) => /(?:^|\/)(?:pages?|page[_-]?\d+|page_\d+)\.json$/i.test(n) || /metadata\/.*\.json$/i.test(n))
    .sort(byPageNumber);

  for (const name of pageFiles) {
    for (const p of readPagesJson(zip, name)) {
      if (!pages.some((x) => x.page_no === p.page_no)) pages.push(p);
    }
  }

  if (!pages.length) {
    for (const name of jsonNames) {
      if (pageFiles.includes(name)) continue;
      const found = readPagesJson(zip, name);
      if (found.length) {
        found.forEach((p) => pages.push(p));
        break;
      }
    }
  }

  if (!pages.length) {
    const main = entries.find((e: any) => /\.(md|markdown|html?)$/i.test(e.entryName) && !/page[_-]?\d+/i.test(e.entryName));
    if (main) {
      const raw = zip.readAsText(main);
      const tables = raw.match(/<table[\s\S]*?<\/table>/gi) ?? [];
      const md = raw.replace(/<table[\s\S]*?<\/table>/gi, " [TABLE] ");
      pages.push({ page_no: 1, text: stripHtml(md), tables, blocks: [], width: 0, height: 0 });
    }
  }

  if (!pages.length) warnings.push(`zip contained no recognisable page output (entries: ${names.join(", ") || "none"})`);

  pages.sort((a, b) => a.page_no - b.page_no);
  return { pages, warnings };
}

/** The manifest is authoritative for page counts, so surface failures instead of silently dropping pages. */
function readManifest(zip: any, entries: any[], warnings: string[]): void {
  const e = entries.find((x: any) => /manifest\.json$/i.test(x.entryName));
  if (!e) return;
  try {
    const m = JSON.parse(zip.readAsText(e.entryName));
    if (m?.status && !/^completed$/i.test(String(m.status))) warnings.push(`manifest status: ${m.status}`);
    const failed = Number(m?.pages_failed ?? 0);
    if (failed > 0) warnings.push(`${failed}/${m?.page_count ?? "?"} pages failed OCR`);
  } catch {
    /* manifest is advisory only */
  }
}

function readPagesJson(zip: any, name: string): VisionPage[] {
  let obj: any;
  try {
    obj = JSON.parse(zip.readAsText(name));
  } catch {
    return [];
  }
  const list: any[] = Array.isArray(obj) ? obj : Array.isArray(obj?.pages) ? obj.pages : [obj];
  const out: VisionPage[] = [];
  for (const [i, o] of list.entries()) {
    if (!o || typeof o !== "object") continue;
    const page = toPage(o, i + 1);
    if (page.text || page.tables.length || page.blocks.length) out.push(page);
  }
  return out;
}

function byPageNumber(a: string, b: string): number {
  const na = Number(/(\d+)/.exec(a)?.[1] ?? 0);
  const nb = Number(/(\d+)/.exec(b)?.[1] ?? 0);
  return na - nb;
}

const TABLE_TAG = /^(table|tabular)/i;

function toPage(obj: any, fallbackNo: number): VisionPage {
  const pageNo = Number(obj?.page_num ?? obj?.page_no ?? obj?.page_number ?? obj?.page ?? fallbackNo);
  const width = Number(obj?.image_width ?? obj?.width ?? 0) || 0;
  const height = Number(obj?.image_height ?? obj?.height ?? 0) || 0;

  const raw: any[] = Array.isArray(obj?.blocks)
    ? obj.blocks
    : Array.isArray(obj?.content)
      ? obj.content
      : Array.isArray(obj?.elements)
        ? obj.elements
        : [];

  const ordered = raw
    .map((b, i) => ({ b, i }))
    .sort((x, y) => (Number(x.b?.reading_order ?? x.i) || 0) - (Number(y.b?.reading_order ?? y.i) || 0));

  const blocks: VisionBlock[] = [];
  const tables: string[] = [];
  const textParts: string[] = [];

  for (const { b } of ordered) {
    const text = String(b?.text ?? b?.content ?? b?.value ?? "").trim();
    if (!text) continue;
    const tag = String(b?.layout_tag ?? b?.tag ?? b?.type ?? b?.block_type ?? "").toLowerCase();
    const box = pickBox(b, width, height);

    if (TABLE_TAG.test(tag) || /^<table[\s>]/i.test(text) || /^\|.*\|$/m.test(text)) {
      const html = text.startsWith("<") ? text : toMarkdownTable(text.split("\n"));
      if (html) {
        tables.push(html);
        textParts.push(stripHtml(html));
        blocks.push({ text: `TABLE ${stripHtml(html).split("\n").join(" | ")}`, tag: "table", bbox: box });
        continue;
      }
    }

    blocks.push({ text, tag, bbox: box });
    textParts.push(text);
  }

  const md = String(obj?.markdown ?? obj?.md ?? "");
  const html = String(obj?.html ?? "");
  const explicit = obj?.text ?? (typeof obj?.content === "string" ? obj.content : undefined);

  const text = normalizeText(
    [typeof explicit === "string" ? explicit : "", md, html, textParts.join("\n")].find((s) => s && String(s).trim()) ?? "",
  );

  return { page_no: pageNo, text, tables, blocks, md, width, height };
}

const finiteBox = (x: number, y: number, w: number, h: number): [number, number, number, number] | null => {
  if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  if (w <= 0 || h <= 0) return null;
  return [x, y, w, h];
};

/**
 * Sarvam returns `coordinates: {x1,y1,x2,y2}` in render pixels plus a
 * `bbox_norm` of the same corners normalised to 0..1. Both are corner-based,
 * so the width/height are derived from the corner deltas.
 */
function pickBox(b: any, pageW = 0, pageH = 0): [number, number, number, number] {
  const c = b?.coordinates ?? b?.coord ?? b?.position;
  if (c && typeof c === "object" && !Array.isArray(c)) {
    const { x1, y1, x2, y2 } = c as Record<string, unknown>;
    if ([x1, y1, x2, y2].every((v) => typeof v === "number")) {
      const box = finiteBox(Number(x1), Number(y1), Number(x2) - Number(x1), Number(y2) - Number(y1));
      if (box) return box;
    }
  }

  const norm = b?.bbox_norm ?? b?.bbox_normalized ?? b?.norm_bbox;
  if (Array.isArray(norm) && norm.length === 4 && norm.every((v: any) => typeof v === "number") && pageW > 0 && pageH > 0) {
    const box = finiteBox(norm[0] * pageW, norm[1] * pageH, (norm[2] - norm[0]) * pageW, (norm[3] - norm[1]) * pageH);
    if (box) return box;
  }

  const cand = b?.bbox ?? b?.bounding_box ?? b?.box ?? b?.bbox_2d ?? b?.position;
  if (Array.isArray(cand) && cand.length === 4 && cand.every((x: any) => typeof x === "number")) {
    const box = finiteBox(cand[0], cand[1], cand[2], cand[3]);
    if (box) return box;
  }
  if (cand && typeof cand === "object") {
    const o = cand as Record<string, any>;
    const x = o.x ?? o.x0 ?? o.left ?? 0;
    const y = o.y ?? o.y0 ?? o.top ?? 0;
    const w = o.w ?? o.width ?? (o.x1 ?? 0) - x;
    const h = o.h ?? o.height ?? (o.y1 ?? 0) - y;
    const box = finiteBox(Number(x), Number(y), Number(w), Number(h));
    if (box) return box;
  }
  return [0, 0, 0, 0];
}

function toMarkdownTable(rows: string[]): string {
  const cells = rows.map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  if (!cells.length) return "";
  const head = cells[0];
  const body = cells.slice(1);
  const out = [`<table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`];
  for (const r of body) out.push(`<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`);
  out.push("</table>");
  return out.join("");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeText(s: string): string {
  return s
    .replace(/<!--[^>]*-->/g, " ")
    .replace(/\[IMAGE[^\]]*\]/gi, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildZipBatch(items: DigitiseInput[]): DigitiseInput {
  const AdmZip = require("adm-zip") as typeof import("adm-zip");
  const zip = new AdmZip();
  for (const it of items) {
    const ext = it.filename.toLowerCase().endsWith(".png") ? "png" : "jpg";
    zip.addFile(it.filename.replace(/\.[^.]+$/, `.${ext}`), Buffer.from(it.bytes));
  }
  return { filename: "pages.zip", bytes: new Uint8Array(zip.toBuffer()), mime: "application/zip" };
}

