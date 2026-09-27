import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./config.js";

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 8000;

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  filename     TEXT NOT NULL,
  title        TEXT,
  mime         TEXT,
  bytes        INTEGER,
  sha256       TEXT,
  page_count   INTEGER DEFAULT 0,
  status       TEXT DEFAULT 'queued',
  route        TEXT,
  error        TEXT,
  private_files INTEGER DEFAULT 0,
  meta         TEXT,
  created_at   INTEGER,
  updated_at   INTEGER
);

CREATE TABLE IF NOT EXISTS pages (
  id           TEXT PRIMARY KEY,
  doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no      INTEGER NOT NULL,
  width        REAL,
  height       REAL,
  text         TEXT,
  char_count   INTEGER DEFAULT 0,
  lang         TEXT,
  quality      REAL,
  quality_json TEXT,
  engine       TEXT,
  render_path  TEXT,
  blocks       TEXT,
  UNIQUE(doc_id, page_no)
);
CREATE INDEX IF NOT EXISTS idx_pages_doc ON pages(doc_id, page_no);

CREATE TABLE IF NOT EXISTS chunks (
  id           TEXT PRIMARY KEY,
  doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no      INTEGER NOT NULL,
  ord          INTEGER NOT NULL,
  text         TEXT NOT NULL,
  lang         TEXT,
  kind         TEXT DEFAULT 'text',
  section_path TEXT,
  bbox         TEXT,
  meta         TEXT,
  token_est    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id, page_no);
CREATE INDEX IF NOT EXISTS idx_chunks_lang ON chunks(lang);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  chunk_id UNINDEXED,
  doc_id UNINDEXED,
  lang UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TABLE IF NOT EXISTS vectors (
  chunk_id   TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  model      TEXT
);
CREATE INDEX IF NOT EXISTS idx_vectors_doc ON vectors(doc_id);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL,
  page_no     INTEGER,
  kind        TEXT NOT NULL,
  state       TEXT DEFAULT 'pending',
  attempts    INTEGER DEFAULT 0,
  next_at     INTEGER DEFAULT 0,
  error       TEXT,
  created_at  INTEGER,
  updated_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, next_at);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  created_at  INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  conv_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  meta        TEXT,
  created_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, created_at);
`);

try { db.exec(`ALTER TABLE documents ADD COLUMN private_files INTEGER DEFAULT 0`); } catch { /* existing database already migrated */ }

export function now(): number {
  return Date.now();
}

export function uid(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function j(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function unj<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
