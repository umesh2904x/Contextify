import { useEffect, useRef, useState } from "react";
import { X, ExternalLink, FileText, Quote } from "lucide-react";
import { api, renderBlobUrl, type AskResult, type Source, type Verdict } from "./api";
import { useUiLanguage } from "./i18n";

export function SourceChip({
  n,
  active,
  verified,
  onClick,
}: {
  n: number;
  active?: boolean;
  verified?: "SUPPORTED" | "CONTRADICTED" | "UNSUPPORTED" | null;
  onClick: () => void;
}) {
  const { t } = useUiLanguage();
  const color =
    verified === "SUPPORTED"
      ? "border-teal-400/60 bg-teal-400/15 text-teal-200"
      : verified === "CONTRADICTED"
        ? "border-amber-400/60 bg-amber-400/15 text-amber-200"
        : verified === "UNSUPPORTED"
          ? "border-rose-400/60 bg-rose-400/15 text-rose-200 line-through"
          : "border-teal-600/50 bg-teal-900/40 text-teal-300";
  return (
    <button
      onClick={onClick}
      title={`${t("Open evidence")} S${n}`}
      className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-[1px] text-[10px] font-semibold leading-none transition ${color} ${
        active ? "ring-2 ring-teal-300" : "hover:bg-teal-800/60"
      }`}
    >
      S{n}
    </button>
  );
}

export function EvidencePanel({ source, onClose }: { source: Source; onClose: () => void }) {
  const { t } = useUiLanguage();
  const [text, setText] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [render, setRender] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setText(null);
    setZoom(1);
    api.pageText(source.doc_id, source.page_no).then((r) => setText(r.text)).catch(() => setText(""));
  }, [source.doc_id, source.page_no]);

  useEffect(() => {
    let active = true;
    setRender(null);
    void renderBlobUrl(source.doc_id, source.page_no).then((url) => {
      if (active) setRender(url);
      else URL.revokeObjectURL(url);
    }).catch(() => setRender(null));
    return () => { active = false; };
  }, [source.doc_id, source.page_no]);

  const hasBox = source.bbox?.length > 0 && source.bbox[0][2] > 0;
  const boxSpaceW = source.page_width > 0 ? source.page_width : source.bbox?.[0]?.[0] + source.bbox?.[0]?.[2];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="panel flex h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-teal-700/40 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-teal-200">
              <Quote size={14} className="shrink-0 text-teal-400" />
              <span className="truncate">{source.doc_title}</span>
              <span className="shrink-0 rounded bg-teal-900/70 px-1.5 py-0.5 text-[10px] font-normal text-teal-300">
                {t("Page")} {source.page_no}
              </span>
              {source.section_path && <span className="truncate text-[11px] font-normal text-teal-400/80">› {source.section_path}</span>}
            </div>
            <div className="mt-0.5 text-[10px] text-teal-500/80">
              {t("Language")}={source.lang} · {t("Type")}={source.kind} · {t("Score")}={source.score} · {t(hasBox ? "region highlight available" : "text source")}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button onClick={() => setZoom((z) => Math.max(0.35, z - 0.25))} className="rounded border border-teal-700/60 px-2 py-1 text-xs text-teal-300 hover:bg-teal-800/50" title={t("Zoom out")}>
              −
            </button>
            <span className="w-10 text-center text-[11px] text-teal-400">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(4, z + 0.25))} className="rounded border border-teal-700/60 px-2 py-1 text-xs text-teal-300 hover:bg-teal-800/50" title={t("Zoom in")}>
              +
            </button>
            <a
              href={render ?? "#"}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-teal-700/60 px-2 py-1 text-teal-300 hover:bg-teal-800/50"
              title={t("Open full page render")}
              onClick={(event) => { if (!render) event.preventDefault(); }}
            >
              <ExternalLink size={13} />
            </a>
            <button onClick={onClose} className="rounded p-1.5 text-teal-400 hover:bg-teal-800/50" title={t("Close")}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div ref={wrap} className="relative flex-1 overflow-auto bg-ink-950 p-4">
          {source.page_width > 0 ? (
            <img
              src={render ?? undefined}
              alt={`${t("Page")} ${source.page_no}`}
              className="block origin-top-left rounded-sm bg-white shadow-2xl"
              style={{ width: `${zoom * 100}%`, maxWidth: "none" }}
            />
          ) : (
            <pre className="indic mx-auto max-w-4xl whitespace-pre-wrap break-words rounded-lg border border-[#e1d0aa] bg-[#fffdf7] p-5 text-sm leading-7 text-[#432c18] shadow-sm">
              {text === null ? t("loading…") : text.slice(0, 12000) || source.snippet}
            </pre>
          )}
          {source.page_width > 0 && hasBox && (
            <div className="pointer-events-none absolute left-4 top-4" style={{ width: `${zoom * 100}%` }}>
              <PageHighlight boxes={source.bbox} pageW={boxSpaceW} />
            </div>
          )}
        </div>

        {source.page_width > 0 && <div className="max-h-[26vh] overflow-auto border-t border-teal-700/40 bg-ink-900/60 px-4 py-3">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-teal-400">
            <FileText size={12} /> {t("Extracted text from this page")}
          </div>
          <pre className="indic whitespace-pre-wrap break-words text-[12px] leading-relaxed text-teal-100/90">
            {text === null ? t("loading…") : text.slice(0, 6000) || t("(no text stored for this page)")}
          </pre>
        </div>}
      </div>
    </div>
  );
}

/** Normalises stored page-space boxes against the true page width of the render. */
function PageHighlight({ boxes, pageW }: { boxes: Array<[number, number, number, number]>; pageW: number }) {
  if (!(pageW > 0)) return null;
  return (
    <>
      {boxes.map((b, i) => (
        <div
          key={i}
          className="hl-box"
          style={{
            left: `${(b[0] / pageW) * 100}%`,
            top: `${(b[1] / pageW) * 100}%`,
            width: `${(b[2] / pageW) * 100}%`,
            height: `${(b[3] / pageW) * 100}%`,
          }}
        />
      ))}
    </>
  );
}

export function VerdictPanel({ verdicts }: { verdicts: Verdict[] }) {
  const { t } = useUiLanguage();
  if (!verdicts.length) return null;
  const counts = verdicts.reduce<Record<string, number>>((a, v) => ({ ...a, [v.status]: (a[v.status] ?? 0) + 1 }), {});
  return (
    <div className="rounded-lg border border-teal-800/60 bg-ink-900/70 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px]">
        <span className="font-semibold uppercase tracking-wide text-teal-400">{t("Verifier report")}</span>
        <span className="text-teal-300">{t("supported")} {counts.SUPPORTED ?? 0}</span>
        {counts.CONTRADICTED ? <span className="text-amber-300">{t("contradicted")} {counts.CONTRADICTED}</span> : null}
        {counts.UNSUPPORTED ? <span className="text-rose-300">{t("removed")} {counts.UNSUPPORTED}</span> : null}
      </div>
      <ul className="space-y-1.5">
        {verdicts.map((v, i) => (
          <li key={i} className="flex gap-2 text-[11.5px] leading-snug">
            <span
              className={`mt-[2px] h-1.5 w-1.5 shrink-0 rounded-full ${
                v.status === "SUPPORTED" ? "bg-teal-400" : v.status === "CONTRADICTED" ? "bg-amber-400" : "bg-rose-400"
              }`}
            />
            <span className={v.status === "UNSUPPORTED" ? "text-teal-500/50 line-through" : "text-teal-100/85"}>{v.sentence}</span>
            {v.note && <span className="shrink-0 text-[10px] text-teal-500/70">({v.note})</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
