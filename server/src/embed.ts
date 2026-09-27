import { createRequire } from "node:module";
import { EMBED_MODEL, EMBED_DIM } from "./config.js";

export { EMBED_DIM };

export type Vec = Float32Array;

let pipe: any = null;
let mode: "model" | "hash" = "hash";
let ready: Promise<void> | null = null;
let lastError = "";

export function embedStatus(): { mode: string; model: string; error: string } {
  return { mode, model: EMBED_MODEL, error: lastError };
}

export function initEmbeddings(): Promise<void> {
  if (!ready) ready = load();
  return ready;
}

async function load(): Promise<void> {
  try {
    // transformers.js needs Node's path/fs to resolve model files. The ESM build of the
    // package cannot reach them, so the CommonJS build is required explicitly.
    const require = createRequire(import.meta.url);
    const t: any = require("@huggingface/transformers");
    t.env.allowLocalModels = false;
    pipe = await t.pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" });
    mode = "model";
    const probe = await embedOne("warmup");
    if (probe.length !== EMBED_DIM) lastError = `model dim ${probe.length} != configured ${EMBED_DIM}`;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    mode = "hash";
    pipe = null;
  }
}

const isE5 = () => /e5/i.test(EMBED_MODEL);

export async function embedOne(text: string, kind: "query" | "passage" = "passage"): Promise<Vec> {
  const input = isE5() ? `${kind === "query" ? "query" : "passage"}: ${text.slice(0, 2000)}` : text.slice(0, 2000);
  if (mode === "model" && pipe) {
    const out = await pipe(input, { pooling: "mean", normalize: true });
    return Float32Array.from(out.data as Float32Array);
  }
  return hashEmbed(text);
}

export async function embedMany(texts: string[], kind: "query" | "passage" = "passage", onProgress?: (i: number) => void): Promise<Vec[]> {
  const out: Vec[] = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(await embedOne(texts[i], kind));
    onProgress?.(i);
  }
  return out;
}

const HASH_DIM = 512;

/** Deterministic lexical-hash embedding: keeps the pipeline runnable when no model can be downloaded. */
function hashEmbed(text: string): Vec {
  const v = new Float32Array(HASH_DIM);
  const toks = tokenize(text);
  for (const [tok, tf] of toks) {
    for (let h = 0; h < 3; h++) {
      const idx = hash(tok + "#" + h) % HASH_DIM;
      const sign = hash(tok + "@" + h) % 2 === 0 ? 1 : -1;
      v[idx] += sign * (1 + Math.log(tf));
    }
  }
  const bi = tokenize(text.replace(/[\s\p{P}]/gu, ""));
  for (const g of bi) {
    for (let k = 0; k < g.length - 2; k++) {
      const trigram = g.slice(k, k + 3);
      const idx = hash("#" + trigram) % HASH_DIM;
      v[idx] += 2.2;
    }
  }
  return normalize(v);
}

function tokenize(text: string): Map<string, number> {
  const m = new Map<string, number>();
  const toks = text.toLowerCase().match(/[\p{L}\p{N}]{1,}/gu) ?? [];
  for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
} 

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  
  return h >>> 0;
}

export function normalize(v: Vec): Vec {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function cosine(a: Vec, b: Vec): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function toBlob(v: Vec): Uint8Array {
  return new Uint8Array(v.buffer.slice(0));
}

export function fromBlob(b: Uint8Array): Vec {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}
