import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Send, Loader2, Globe, ShieldCheck, AlertTriangle, MessagesSquare, Trash2, GitCompare, FileText } from "lucide-react";
import { api, type AskResult, type Source } from "./api";
import { EvidencePanel, SourceChip, VerdictPanel } from "./Evidence";
import { useUiLanguage } from "./i18n";

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  result?: AskResult;
  pending?: boolean;
};

export function Chat({ autoAsk, onAsked }: { autoAsk?: string | null; onAsked?: () => void }) {
  const { t } = useUiLanguage();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [conv, setConv] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [crossLingual, setCrossLingual] = useState(true);
  const [evidence, setEvidence] = useState<Source | null>(null);
  const [convs, setConvs] = useState<Array<{ id: string; title: string }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  useEffect(() => {
    api.conversations().then((r) => setConvs(r.conversations)).catch(() => {});
  }, []);

  useEffect(() => {
    if (autoAsk) {
      void send(autoAsk);
      onAsked?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk]);

  const send = async (text?: string) => {
    const query = (text ?? q).trim();
    if (!query || busy) return;
    setQ("");
    setBusy(true);
    const mine: Msg = { id: `u${Date.now()}`, role: "user", content: query };
    setMsgs((m) => [...m, mine, { id: `p${Date.now()}`, role: "assistant", content: "", pending: true }]);
    try {
      const res = await api.ask({ query, conversation_id: conv ?? undefined, cross_lingual: crossLingual, verify: false });
      setConv(res.conversation_id);
      setMsgs((m) => [...m.filter((x) => !x.pending), { id: `a${Date.now()}`, role: "assistant", content: res.answer, result: res }]);
      api.conversations().then((r) => setConvs(r.conversations)).catch(() => {});
    } catch (e) {
      setMsgs((m) => [...m.filter((x) => !x.pending), { id: `e${Date.now()}`, role: "assistant", content: `${t("Request failed")}: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  const newConv = async () => {
    const r = await api.conversations();
    void r;
    setConv(null);
    setMsgs([]);
  };

  const loadConv = async (id: string) => {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const { messages } = await api.messages(id);
      setConv(id);
      setMsgs(messages.map((m: any) => ({
        id: m.id,
        role: m.role === "user" ? "user" as const : "assistant" as const,
        content: m.content ?? "",
        result: m.role === "assistant" ? m.meta ?? undefined : undefined,
      })));
      if (!messages.length) setHistoryError(t("This conversation has no messages."));
    } catch {
      setHistoryError(t("Couldn't open this conversation."));
    } finally {
      setHistoryLoading(false);
    }
  };

  const deleteConv = async (id: string) => {
    setHistoryError("");
    try {
      await api.deleteConversation(id);
      setConvs((current) => current.filter((item) => item.id !== id));
      if (conv === id) {
        setConv(null);
        setMsgs([]);
      }
    } catch {
      setHistoryError(t("Couldn't delete this conversation."));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-teal-800/50 px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-teal-200">
          <MessagesSquare size={15} className="text-teal-400" /> {t("Ask across all documents")}
        </h2>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setCrossLingual(!crossLingual)}
            title={t("Search for answers across document languages")}
            className={`flex items-center gap-1 rounded border px-2 py-1 text-[10.5px] ${
              crossLingual ? "border-teal-400/60 bg-teal-400/15 text-teal-200" : "border-teal-800 text-teal-500"
            }`}
          >
            <Globe size={12} /> {t(crossLingual ? "Across languages on" : "Across languages off")}
          </button>
        </div>
      </div>

      {convs.length > 0 && (
        <div className="flex max-h-28 flex-wrap gap-1 overflow-hidden border-b border-rose-900/70 px-4 py-1.5">
          {convs.slice(0, 8).map((c) => (
            <div key={c.id} className={`flex min-w-0 max-w-full items-center gap-1 rounded-full pl-2.5 pr-1 text-[10.5px] ${conv === c.id ? "bg-rose-500/20 text-rose-50" : "bg-rose-950/40 text-rose-200/80"}`}>
              <button
                onClick={() => void loadConv(c.id)}
                className="max-w-[150px] truncate py-1 text-left hover:text-white"
                title={c.title}
              >
                {c.title}
              </button>
              <button
                onClick={() => void deleteConv(c.id)}
                className="rounded p-1 hover:bg-rose-800/60 hover:text-white"
                title={t("Delete conversation")}
                aria-label={`${t("Delete conversation")}: ${c.title}`}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 space-y-4 overflow-auto px-4 py-4">
        {historyLoading && <div className="flex items-center justify-center gap-2 py-8 text-sm text-[#725733]"><Loader2 size={16} className="spin" />{t("Opening conversation…")}</div>}
        {historyError && <div role="status" className="mx-auto max-w-xl rounded-lg border border-[#ddc99f] bg-[#fff7df] px-4 py-3 text-center text-sm text-[#614321]">{historyError}</div>}
        {msgs.length === 0 && !historyLoading && !historyError && (
          <div className="mx-auto max-w-2xl pt-6 text-center">
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#f8e7bd] text-[#a75b1a]">
              <MessagesSquare size={22} />
            </motion.div>
            <h1 className="mt-4 text-2xl font-semibold text-[#432c18]">{t("Ask your documents.")}</h1>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#92734a]">{t("Upload a file from the library to start. Answers include pages you can open and review.")}</p>
          </div>
        )}

        <AnimatePresence initial={false}>
          {msgs.map((m) =>
            m.role === "user" ? (
              <motion.div key={m.id} initial={{ opacity: 0, y: 12, x: 16 }} animate={{ opacity: 1, y: 0, x: 0 }} exit={{ opacity: 0, y: -8 }} className="flex justify-end">
                <div className="indic max-w-[80%] rounded-2xl rounded-br-sm bg-gradient-to-r from-rose-400 via-fuchsia-400 to-violet-400 px-3.5 py-2 text-[13px] leading-relaxed text-[#1b0712] shadow-[0_18px_30px_rgba(236,72,153,0.25)]">{m.content}</div>
              </motion.div>
            ) : (
              <AssistantBubble key={m.id} msg={m} onEvidence={setEvidence} />
            ),
          )}
        </AnimatePresence>
        <div ref={bottom} />
      </div>

      <div className="border-t border-rose-800/50 px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <div className="chat-input-shell flex-1 rounded-lg bg-gradient-to-r from-[#d58a2e] via-[#ffe3a0] to-[#d58a2e] p-[2px]">
            <textarea
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder={t("Ask about your files in any language… (Enter to send, Shift+Enter for newline)")}
              className="indic max-h-32 w-full resize-none rounded-[7px] border-0 bg-[#fffdf8] px-3.5 py-2.5 text-[13px] font-medium text-[#2f2114] placeholder:text-[#4b3828] shadow-[inset_0_1px_2px_rgba(110,75,26,0.05)] focus:outline-none"
            />
          </div>
          <button
            onClick={() => send()}
            disabled={busy || !q.trim()}
            className="send-button flex h-[42px] w-[42px] items-center justify-center rounded-lg bg-[#b9671f] text-[#17100a] shadow-[0_10px_22px_rgba(112,65,21,0.28)] transition hover:bg-[#945018] disabled:opacity-40"
          >
            {busy ? <Loader2 size={17} className="spin" /> : <Send size={17} />}
          </button>
        </div>
      </div>

      {evidence && <EvidencePanel source={evidence} onClose={() => setEvidence(null)} />}
    </div>
  );
}

function AssistantBubble({ msg, onEvidence }: { msg: Msg; onEvidence: (s: Source) => void }) {
  const { t } = useUiLanguage();
  const r = msg.result
    ? {
        ...msg.result,
        sources: Array.isArray(msg.result.sources) ? msg.result.sources : [],
        conflicts: Array.isArray(msg.result.conflicts) ? msg.result.conflicts : [],
        verdicts: Array.isArray(msg.result.verdicts) ? msg.result.verdicts : [],
        stats: {
          query_lang: "",
          rewritten: "",
          retrieved: 0,
          top_score: 0,
          coverage: 0,
          provider: "",
          llm_model: "",
          cross_lingual: false,
          verified: 0,
          stripped: 0,
          ...(msg.result.stats ?? {}),
        },
      }
    : undefined;
  if (msg.pending) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-teal-400/80">
        <Loader2 size={13} className="spin" /> {t("Finding relevant pages and preparing an answer…")}
      </div>
    );
  }

  const verdictBySentence = new Map<string, "SUPPORTED" | "CONTRADICTED" | "UNSUPPORTED">();
  for (const v of r?.verdicts ?? []) verdictBySentence.set(v.sentence.trim().slice(0, 60), v.status);

  const parts = (msg.content || "").split(/\[S\d+\](?:\[\d+\])*/g);
  const citedNumbers = new Set(Array.from(msg.content.matchAll(/\[S(\d+)\]/g), (match) => Number(match[1])));
  const citedSources = r?.sources.filter((source) => citedNumbers.has(source.n)) ?? [];
  const displaySources = citedSources.length ? citedSources : r?.sources.slice(0, 1) ?? [];

  return (
    <div className="space-y-2.5">
      {r?.abstained && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-950/20 px-3 py-2 text-[11.5px] text-amber-200">
          <AlertTriangle size={14} className="mt-[1px] shrink-0" />
          <div>
            <b>{t("Abstained.")}</b> {t(r.abstain_reason ?? "")}
          </div>
        </div>
      )}

      <div className="indic rounded-2xl rounded-bl-sm border border-teal-800/60 bg-ink-850/80 px-3.5 py-3 text-[13.5px] leading-relaxed text-teal-50">
        {parts.map((p, i) => <span key={i}>{p}</span>)}
      </div>

      {displaySources.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-teal-400">
          {displaySources.map((source) => (
            <button
              key={source.chunk_id}
              onClick={() => onEvidence(source)}
              title={`${t("Open evidence")}: ${source.doc_title}`}
              className="inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-teal-900/60 hover:text-teal-200"
            >
              <FileText size={11} className="shrink-0" />
              <span className="max-w-64 truncate font-medium">{source.doc_title}</span>
              <span className="shrink-0 text-teal-500/70">{t("Page")} {source.page_no}</span>
            </button>
          ))}
        </div>
      )}

      {!!r && r.conflicts.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-950/15 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-amber-300">
            <GitCompare size={13} /> {t("Conflicting sources — not resolved, shown side by side")}
          </div>
          {r.conflicts.map((c, i) => (
            <div key={i} className="mb-1.5 last:mb-0">
              <div className="text-[11.5px] text-amber-100/90">
                <b>{c.entity}</b> › {c.attribute} <span className="text-amber-400/60">({c.note})</span>
              </div>
              <ul className="mt-1 space-y-0.5">
                {c.values.map((v, k) => (
                  <li key={k} className="flex items-center gap-1.5 text-[11px] text-amber-100/75">
                    <span className="rounded bg-amber-500/20 px-1 py-[1px] text-[10px]">{v.value}</span>
                    <span className="text-amber-400/50">
                      {v.doc} p.{v.page} ·
                    </span>
                    <SourceChip n={v.source} onClick={() => r.sources.find((s) => s.n === v.source) && onEvidence(r.sources.find((s) => s.n === v.source)!)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {r && (
        <details className="rounded-lg border border-teal-800/60 bg-ink-900/50 px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-medium text-teal-400">
            {t("Sources and answer checks")} · {r.sources.length} {t(r.sources.length === 1 ? "page" : "pages")}
            {r.stats.stripped ? ` · ${r.stats.stripped} ${t(r.stats.stripped === 1 ? "unsupported detail" : "unsupported details")} ${t("removed")}` : ""}
          </summary>
          <ul className="mt-2 space-y-1.5">
            {r.sources.map((s) => (
              <li key={s.chunk_id}>
                <div className="flex w-full items-start gap-1.5 rounded border border-teal-800/60 bg-ink-900/70 p-2 hover:border-teal-500/70">
                  <SourceChip n={s.n} active={false} onClick={() => onEvidence(s)} />
                  <button onClick={() => onEvidence(s)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-1.5 text-[10.5px] text-teal-300">
                    <span className="truncate font-medium">{s.doc_title}</span>
                    <span className="shrink-0 text-teal-500/70">p.{s.page_no}</span>
                    {s.section_path && <span className="truncate text-teal-500/60">› {s.section_path}</span>}
                    <span className="ml-auto shrink-0 text-teal-500/50">{s.lang}</span>
                    </div>
                    <div className="indic mt-1 line-clamp-2 text-[11px] leading-snug text-teal-100/65">{s.snippet}</div>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {r?.verdicts && r.verdicts.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[11px] font-medium text-teal-400">
            <ShieldCheck size={11} className="mr-1 inline" />
            {t("Answer checks")} ({r.verdicts.length})
          </summary>
          <div className="mt-1.5">
            <VerdictPanel verdicts={r.verdicts} />
          </div>
        </details>
      )}
    </div>
  );
}
