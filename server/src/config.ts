import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const f of [".env", ".env.local"]) {
  const p = resolve(ROOT, f);
  if (!existsSync(p)) continue;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

export const ROOT_DIR = ROOT;
export const DATA_DIR = resolve(ROOT, "data");
export const UPLOAD_DIR = resolve(DATA_DIR, "uploads");
export const RENDER_DIR = resolve(DATA_DIR, "renders");
export const DB_PATH = resolve(DATA_DIR, "docintel.db");
export const RENDER_SCALE = 1.6;

for (const d of [DATA_DIR, UPLOAD_DIR, RENDER_DIR]) mkdirSync(d, { recursive: true });

export const PORT = Number(process.env.PORT ?? 8787);
export const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? "";
export const SARVAM_KEY = process.env.SARVAM_API_KEY ?? "";
export const SARVAM_TEXT_MODEL = process.env.SARVAM_TEXT_MODEL ?? "sarvam-105b";
export const SARVAM_VISION_MODEL = process.env.SARVAM_VISION_MODEL ?? "doc-ai/sarvam-vision-2.0-v0.1";
export const SARVAM_LID_MODEL = process.env.SARVAM_LID_MODEL ?? "text-lid/v1";
export const SARVAM_TRANSLATE_MODEL = process.env.SARVAM_TRANSLATE_MODEL ?? "sarvam-translate:v1";
export const SARVAM_BASE = "https://api.sarvam.ai";
export const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";
export const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.1-8b-instant";
export const XAI_API_KEY = process.env.XAI_API_KEY ?? "";
export const XAI_MODEL = process.env.XAI_MODEL ?? "grok-3-mini";
export const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b-instruct";
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "Xenova/multilingual-e5-small";
export const EMBED_DIM = Number(process.env.EMBED_DIM ?? 384);
export const PAGES_PER_VISION = Number(process.env.CHUNK_PAGES_PER_VISION_CALL ?? 8);
export const VISION_MAX_RPM = Number(process.env.VISION_MAX_RPM ?? 10);
export const LLM_ENABLED = SARVAM_KEY.length > 0 || GROQ_API_KEY.length > 0;
