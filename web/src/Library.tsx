import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Upload, FileText, Trash2, RefreshCw, Loader2, Search, Layers, Pencil, Check, X } from "lucide-react";
import { api, renderBlobUrl, type DocRow, type Health } from "./api";
import { useUiLanguage } from "./i18n";

const ROUTE_LABEL: Record<string, { text: string; cls: string }> = {
  digital: { text: "Text document", cls: "border-teal-400/50 text-teal-300 bg-teal-400/10" },
  hybrid: { text: "Mixed pages", cls: "border-sky-400/50 text-sky-300 bg-sky-400/10" },
  "vision-ocr": { text: "Scanned document", cls: "border-amber-400/50 text-amber-300 bg-amber-400/10" },
  "vision-table": { text: "Tables and layout", cls: "border-violet-400/50 text-violet-300 bg-violet-400/10" },
  "vision-noisy": { text: "Needs review", cls: "border-rose-400/50 text-rose-300 bg-rose-400/10" },
  empty: { text: "No text found", cls: "border-slate-500/50 text-slate-400 bg-slate-500/10" },
};

export function Library({ onAsk, showPrivateFiles }: { onAsk: (q: string) => void; showPrivateFiles?: boolean }) {
  const { t } = useUiLanguage();
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [privateUpload, setPrivateUpload] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      const nextDocs = (await api.docs()).documents;
      setDocs((current) => JSON.stringify(current) === JSON.stringify(nextDocs) ? current : nextDocs);
    } catch {
      /* server restarting */
    }
    try {
      const nextHealth = await api.health();
      setHealth((current) => JSON.stringify(current) === JSON.stringify(nextHealth) ? current : nextHealth);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, []);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setPct(0);
    try {
      const result = await api.upload(Array.from(files), setPct, privateUpload);
      try {
        setDocs((await api.docs()).documents);
      } catch {
        /* the upload response remains authoritative while the library refreshes */
      }
      void api.health().then(setHealth).catch(() => {});
      if (result.rejected?.length) alert(`${t("Some files could not be added")}: ${result.rejected.map((file) => file.filename).join(", ")}`);
    } catch (e) {
      alert(`${t("Upload failed")}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setPct(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const processing = docs.filter((d) => d.status === "queued" || d.status === "processing");
  const visibleDocs = docs.filter((d) => showPrivateFiles || !d.private_files);

  const saveTitle = async (id: string) => {
    const title = editingTitle.trim();
    if (!title) return;
    try {
      await api.rename(id, title);
      setDocs((current) => current.map((doc) => doc.id === id ? { ...doc, title } : doc));
      setEditingId(null);
    } catch {
      /* keep the editor open so the user can retry */
    }
  };

  const confirmDelete = async () => {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await api.del(deleteId);
      setDocs((current) => current.filter((doc) => doc.id !== deleteId));
      if (openId === deleteId) setOpenId(null);
      setDeleteId(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-teal-800/50 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-teal-200">
            <Layers size={15} className="text-teal-400" /> {t("Document library")}
          </h2>
          <span className="text-[10px] text-teal-500/80">
            {health ? `${health.corpus.docs} ${t("documents")}` : t("Loading…")}
          </span>
        </div>

        <motion.button
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.99 }}
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="upload-dropzone mt-2.5 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[#b87820] px-3 py-3 text-xs font-bold text-[#3b210b] transition hover:brightness-[1.03] disabled:opacity-60"
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
          {busy ? `${t("Uploading")} ${pct ?? 0}%` : t("Upload documents")}
        </motion.button>
        <div className="mt-1.5 text-center text-[10px] text-[#715c3c]">{t("PDF, PPTX, DOCX, XLSX, ODT/ODP/ODS, RTF, CSV, MD, HTML, EPUB, TXT/JSON, PNG/JPG/GIF/WebP")}</div>
        <label className="mt-2 flex items-center justify-center gap-2 text-xs font-semibold text-[#432c18]">
          <input type="checkbox" checked={privateUpload} onChange={(event) => setPrivateUpload(event.target.checked)} className="accent-[#a8671f]" />
          {t("Add uploaded files as private")}
        </label>
        <div className="mt-3 border-t-2 border-[#c89a52]" aria-hidden="true" />
        <input ref={fileRef} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.pptx,.docx,.xlsx,.odt,.odp,.ods,.odg,.rtf,.csv,.md,.html,.epub,.txt,.json,.log" className="hidden" onChange={(e) => upload(e.target.files)} />

        {health?.pending_jobs ? <div className="mt-2 text-[10px] text-amber-700">{t("Preparing")} {health.pending_jobs} {t(health.pending_jobs === 1 ? "document for search…" : "documents for search…")}</div> : null}

      </div>

      <div className="flex-1 overflow-auto border-t border-[#ead4a8]">
        {processing.length > 0 && (
          <div className="border-b border-rose-900/60 px-4 py-2 text-[11px] text-amber-300">
            {t("Preparing")} {processing.length} {t(processing.length === 1 ? "document for search…" : "documents for search…")}
          </div>
        )}
        {visibleDocs.length === 0 && <div className="px-4 py-8 text-center text-xs text-rose-200/70">{t("No documents yet. Upload a file to begin.")}</div>}
        {visibleDocs.map((d, idx) => {
          const r = ROUTE_LABEL[d.route ?? ""] ?? { text: d.route ?? "pending", cls: "border-slate-500/50 text-slate-400" };
          return (
            <motion.div
              key={d.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, delay: idx * 0.04 }}
              className="border-b border-rose-950/80 px-4 py-2.5 hover:bg-rose-950/20"
            >
              <div className="flex items-start gap-2">
                <FileText size={13} className="mt-[2px] shrink-0 text-rose-300" />
                <div className="min-w-0 flex-1">
                  {editingId === d.id ? (
                    <div className="flex items-center gap-1">
                      <input autoFocus value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveTitle(d.id); if (event.key === "Escape") setEditingId(null); }} className="min-w-0 flex-1 rounded border border-[#c89a52] bg-white px-1.5 py-1 text-xs font-semibold text-[#2f1b0b] outline-none" />
                      <button onClick={() => void saveTitle(d.id)} className="rounded p-1 text-[#704215] hover:bg-[#fff0c9]" title={t("Save name")}><Check size={12} /></button>
                      <button onClick={() => setEditingId(null)} className="rounded p-1 text-[#704215] hover:bg-[#fff0c9]" title={t("Cancel")}><X size={12} /></button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <button onClick={() => setOpenId(openId === d.id ? null : d.id)} className="min-w-0 truncate text-left text-xs font-medium text-rose-50 hover:underline" title={t("Open document")}>
                        {d.title || d.filename}
                      </button>
                      <button onClick={() => { setEditingId(d.id); setEditingTitle(d.title || d.filename); }} className="shrink-0 rounded p-1 text-[#704215] hover:bg-[#fff0c9]" title={t("Rename document")}><Pencil size={11} /></button>
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className={`rounded border px-1.5 py-[1px] text-[9.5px] ${r.cls}`}>{t(r.text)}</span>
                    {d.status === "ready" && <span className="text-[9.5px] text-rose-200/80">{d.page_count}p · {d.chunk_count} chunks</span>}
                    {d.status === "failed" && <span className="text-[9.5px] text-rose-400">{t(d.error ?? "Failed")}</span>}
                    {(d.status === "queued" || d.status === "processing") && (
                      <span className="flex items-center gap-1 text-[9.5px] text-amber-300">
                        <Loader2 size={9} className="spin" /> {d.status === "processing" && d.page_count > 0
                          ? `${t("Scanning pages")} ${d.indexed_pages}/${d.page_count}`
                          : t(d.status === "queued" ? "Waiting" : "Preparing")}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => setOpenId(openId === d.id ? null : d.id)} className="rounded p-1 text-rose-200 hover:bg-rose-800/50 hover:text-rose-50" title={t("Inspect pages")}>
                    <Search size={12} />
                  </button>
                  <button onClick={() => api.rerun(d.id).then(refresh)} className="rounded p-1 text-rose-200 hover:bg-rose-800/50 hover:text-rose-50" title={t("Reprocess")}>
                    <RefreshCw size={12} />
                  </button>
                  <button onClick={() => setDeleteId(d.id)} className="rounded p-1 text-rose-200 hover:bg-rose-900/40 hover:text-rose-50" title={t("Delete")}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              {openId === d.id && <DocInspector id={d.id} onAsk={onAsk} />}
            </motion.div>
          );
        })}
      </div>
      {deleteId && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#3a2415]/45 p-4">
          <div className="w-full max-w-sm rounded-xl border border-[#d9bd85] bg-[#fffdf6] p-5 shadow-[0_24px_70px_rgba(70,40,12,0.25)]">
            <h2 className="text-lg font-bold text-[#342313]">{t("Delete document?")}</h2>
            <p className="mt-1 text-sm leading-5 text-[#604c33]">{t("This document will be removed from the library. Please confirm.")}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteId(null)} disabled={deleting} className="rounded-lg border border-[#d8c69e] px-3 py-2 text-sm font-semibold text-[#604c33]">{t("Cancel")}</button>
              <button type="button" onClick={() => void confirmDelete()} disabled={deleting} className="rounded-lg bg-[#9b3f22] px-3 py-2 text-sm font-bold text-white disabled:opacity-50">{deleting ? t("Deleting…") : t("Delete document")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DocInspector({ id, onAsk }: { id: string; onAsk: (q: string) => void }) {
  const { t } = useUiLanguage();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.doc>> | null>(null);
  const [page, setPage] = useState(1);
  const [render, setRender] = useState<string | null>(null);
  const [renderError, setRenderError] = useState(false);
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [fullView, setFullView] = useState(false);

  useEffect(() => {
    const t = setInterval(() => api.doc(id).then(setData).catch(() => {}), 2500);
    api.doc(id).then(setData).catch(() => {});
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    let active = true;
    setRender(null);
    setRenderError(false);
    const timer = window.setTimeout(() => { if (active) setRenderError(true); }, 8000);
    void renderBlobUrl(id, page).then((url) => {
      if (active) setRender(url);
      else URL.revokeObjectURL(url);
    }).catch(() => { if (active) setRenderError(true); }).finally(() => window.clearTimeout(timer));
    return () => { active = false; window.clearTimeout(timer); };
  }, [id, page, renderAttempt]);

  if (!data) return <div className="mt-2 pl-6 text-[10px] text-teal-500/70">{t("loading…")}</div>;

  const p = data.pages.find((x) => x.page_no === page);
  const meta = data.document.meta ?? {};

  return (
    <div className="mt-2 pl-6">
      <div className="mb-1.5 flex items-center gap-1">
        {data.pages.slice(0, 14).map((x) => (
          <button
            key={x.page_no}
            onClick={() => setPage(x.page_no)}
            className={`h-5 w-5 rounded text-[9px] ${x.page_no === page ? "bg-teal-400 text-ink-950" : "bg-teal-900/70 text-teal-300 hover:bg-teal-800"}`}
            title={`${t("Page")} ${x.page_no}${x.lang ? ` · ${x.lang}` : ""}`}
          >
            {x.page_no}
          </button>
        ))}
      </div>
      {p && (
        <div className="rounded border border-teal-800/60 bg-ink-900/60 p-2">
          <div className="flex flex-wrap gap-2 text-[9.5px] text-teal-400/90">
            <span>{t("Page")} {p.page_no}</span>
            <span>{p.char_count.toLocaleString()} {t("characters")}</span>
            <span>{p.lang ?? t("Language not detected")}</span>
          </div>
          {p.quality_json?.reasons?.length ? (
            <ul className="mt-1 space-y-[2px] text-[9.5px] text-amber-300/80">
              {p.quality_json.reasons.map((r: string, i: number) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
          ) : (
            <div className="mt-1 text-[9.5px] text-teal-500/70">{t("Text extracted successfully.")}</div>
          )}
          {p.has_render && render && <button type="button" className="mt-1.5 block cursor-zoom-in" onClick={() => setFullView(true)} title={t("Open full page render")}><img src={render} alt={`${t("Page")} ${p.page_no}`} className="max-h-40 w-auto rounded border border-teal-800/60 bg-white" /></button>}
          {p.has_render && !render && !renderError && <div className="mt-1.5 rounded border border-[#d9bd85] bg-[#fff8e7] px-2 py-1 text-xs text-[#5a3513]">{t("Loading preview…")}</div>}
          {p.has_render && renderError && <button type="button" onClick={() => setRenderAttempt((attempt) => attempt + 1)} className="mt-1.5 rounded border border-[#c89a52] bg-[#fff0c9] px-2 py-1 text-xs font-semibold text-[#4b2d13] hover:bg-[#ffe3a0]">{t("Preview unavailable. Retry")}</button>}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {["What is the total budget?", "Summarise the key figures", "Which scheme covers this?"].map((s) => (
          <button key={s} onClick={() => onAsk(s)} className="rounded bg-teal-900/60 px-1.5 py-[2px] text-[9.5px] text-teal-300 hover:bg-teal-800/60">
            {t(s)}
          </button>
        ))}
      </div>
      {fullView && render && (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#24170e]/95 p-4" role="dialog" aria-modal="true" aria-label={t("Open full page render")}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold text-white">{t("Page")} {p.page_no}</span>
            <button type="button" onClick={() => setFullView(false)} className="rounded-lg bg-[#fff0c9] px-3 py-2 text-sm font-bold text-[#2f1b0b] hover:bg-white">{t("Back to workspace")}</button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg bg-[#fffdf8] p-3">
            <img src={render} alt={`${t("Page")} ${p.page_no}`} className="max-h-full max-w-full object-contain" />
          </div>
        </div>
      )}
    </div>
  );
}
