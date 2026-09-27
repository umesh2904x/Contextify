# Contextify

Upload heterogeneous documents → per-page pipeline routing → hybrid multilingual retrieval →
verifier-guarded answer with page-region evidence.

**Stack:** Node 24 + TypeScript (Hono, `node:sqlite`, pdf.js, transformers.js ONNX, `@napi-rs/canvas`) + React 18 / Vite / Tailwind v4. No Python, no Docker, no Postgres.

## Run

```bash
npm install
npm run dev      # api :8787 + web :5173
```

Open http://localhost:5173

`.env` holds the keys. Set `XAI_API_KEY` to use xAI first for faster answers; Sarvam, Groq, and Ollama remain automatic fallbacks. `SARVAM_API_KEY` is required for document vision. Sign-in requires Supabase — set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the project-root `.env` before starting the dev server.

## The pipeline

| Stage | Implementation |
|---|---|
| **Ingest** | `server/src/index.ts` `POST /api/upload` → sha256-deduped store, FIFO ingest queue |
| **Route** | `ingest/quality.ts` scores every page: chars/page, raster-area ratio (operator-list scan), broken-glyph ratio, invisible/OCR-invisible font (text-render-mode 3), rotation, monospace ratio, sub-5pt ratio, word-length noise, table alignment. Score ≥0.45 → local pdf.js; otherwise Sarvam Vision (with `vision-table` / `vision-noisy` sub-routes). |
| **Digitise** | Sarvam Vision `POST /doc-ai/v1/job/digitise`, `output_format=json` (gives per-block **bounding boxes**). Pages batched 10-per-ZIP, 10 req/min throttle, exponential backoff. |
| **Chunk** | `ingest/chunk.ts` — heading-detected section paths, ~780-char chunks, and **header-aware table rows** (`Total Revenue: 1,204.5` per row) so numeric questions hit the right row. |
| **Index** | FTS5 (unicode61, diacritics-stripped) + dense vectors in the same SQLite file. Embeddings: `multilingual-e5-small` ONNX q8, CPU, `"query:"/"passage:"` prefixes. |
| **Retrieve** | BM25 ⊕ dense → RRF fusion (k=60) → lexical rerank with script-affinity, table and numeric boosts. Zero-pivot cross-lingual: a Hindi query retrieves Telugu/Tamil chunks with no translation layer. |
| **Answer** | `answer.ts` — conversation-aware query rewrite (coreference), claim extraction, **numeric normalisation for conflict detection** (`4,200 crore` ≡ `42,000,000,000`), draft from Sarvam-105B with `[Sn]` markers, then a **verifier pass** that classifies every sentence SUPPORTED / CONTRADICTED / UNSUPPORTED and strips the unsupported ones. |
| **Evidence** | Every citation resolves to `doc_id` + `page_no` + bbox. Clicking `[S3]` opens the rendered page with the exact region highlighted (`web/src/Evidence.tsx`). |

## Reliability behaviour

- **Abstention** — coverage below threshold or `INSUFFICIENT EVIDENCE` from the drafter returns an explicit refusal plus the nearest evidence, never a guess.
- **Conflicts** — same `(entity, attribute)` with differing values across sources is surfaced side by side and left unresolved by design.
- **Verification** — unsupported sentences are removed and reported; the count is shown in the UI.
- **Failure honesty** — a document is only marked `ready` once at least one chunk is indexed. Pages whose OCR returns no text, or whose vision job failed, surface a `failed` status with a reason instead of silently appearing searchable.

## Notes

- Sarvam-105B has reasoning on by default and reasoning tokens bill against `max_tokens`; the client sends `reasoning_effort: null` for short structured calls (~300 ms vs multi-second).
- Vision caps at 10 pages/PDF and 10 req/min, hence the batched ZIP queue. The job download is a ZIP holding `pages.json` (per-page `blocks` with `coordinates`/`bbox_norm` in render-pixel space) plus `manifest.json`; block coordinates are rescaled onto page units so evidence highlights land on the right region.
- `EMBED_MODEL` is swappable; a deterministic lexical-hash embedder takes over automatically if the ONNX model cannot load, so the pipeline never hard-fails.
- `npm run build && npm run electron` wraps the built UI as a desktop dashboard.
