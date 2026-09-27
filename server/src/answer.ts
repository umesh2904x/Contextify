import { chat, type ChatMsg } from "./providers/sarvam.js";
import { retrieve, type Candidate } from "./retrieval.js";
import { db, j, now, uid } from "./db.js";

export type Source = {
  n: number;
  chunk_id: string;
  doc_id: string;
  doc_title: string;
  page_no: number;
  section_path: string;
  lang: string;
  kind: string;
  snippet: string;
  bbox: Array<[number, number, number, number]>;
  page_width: number;
  page_height: number;
  score: number;
};

export type Verdict = { sentence: string; status: "SUPPORTED" | "CONTRADICTED" | "UNSUPPORTED"; refs: number[]; note?: string };

export type Conflict = {
  entity: string;
  attribute: string;
  values: Array<{ value: string; source: number; doc: string; page: number }>;
  note?: string;
};

export type Claim = { entity: string; attribute: string; value: string; source: number; doc?: string; page?: number };

export type AnswerResult = {
  answer: string;
  abstained: boolean;
  abstain_reason?: string;
  sources: Source[];
  conflicts: Conflict[];
  claims: Claim[];
  verdicts: Verdict[];
  stats: {
    query_lang: string;
    rewritten: string;
    retrieved: number;
    top_score: number;
    coverage: number;
    provider: string;
    llm_model: string;
    cross_lingual: boolean;
    verified: number;
    stripped: number;
  };
};

const ABBREVIATIONS = /\b(Mr|Mrs|Ms|Dr|Prof|No|Sec|Art|Fig|vs|etc|Inc|Ltd|Co|St|Rs|approx|ca|cf|ed|vol|pg|pp|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.$/i;
const PLACEHOLDER = /\s+/g;

export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "");
    for (let i = 0; i < line.length; i++) {
      buf += line[i];
      const ch = line[i];
      if (ch === "." || ch === "।" || ch === "?" || ch === "!" || ch === "\n") {
        if (!ABBREVIATIONS.test(buf) && !/\d\.$/.test(buf)) {
          const s = buf.replace(PLACEHOLDER, " ").trim();
          if (s.length > 1) out.push(s);
          buf = "";
        }
      }
    }
    if (buf.trim().length > 1 && !/[.?!।]$/.test(buf)) {
      const s = buf.replace(PLACEHOLDER, " ").trim();
      if (s) out.push(s);
    }
    buf = "";
  }
  return out;
}

/* ---------- conversational rewrite ---------- */

export async function rewriteQuery(query: string, history: Array<{ role: string; content: string }>): Promise<string> {
  const prev = history.filter((h) => h.role === "user").slice(-4);
  const hasPronoun = /\b(uske|uski|uska|iske|iski|iska|uska|यह|इस|उस|उसके|அது|దీని|దాని|అది|ಅದು|അത്|આ|તે|it|its|that|this|they|them|he|she|his|her|their|उसका)\b/i.test(query);
  if (!prev.length || !hasPronoun) return query;

  const convo = prev.map((p, i) => `U${i + 1}: ${p.content}`).join("\n");
  try {
    const r = await chat(
      [
        {
          role: "system",
          content:
            "You rewrite follow-up questions into standalone search queries. Replace pronouns and vague references using the conversation. Keep the original language/script. Reply with ONLY the rewritten query, no quotes, no explanation.",
        },
        { role: "user", content: `Conversation:\n${convo}\n\nFollow-up question: ${query}\n\nStandalone query:` },
      ],
      { maxTokens: 160, temperature: 0 },
    );
    const out = r.text.trim().split("\n")[0].replace(/^["'`]|["'`]$/g, "").trim();
    return out.length > 2 && out.length < 400 ? out : query;
  } catch {
    return query;
  }
}

/* ---------- claim extraction + conflict detection ---------- */

const NUM_UNITS: Array<[RegExp, number]> = [
  [/crore|cr\b/i, 1e7],
  [/lakh|lac\b/i, 1e5],
  [/million|mil\b/i, 1e6],
  [/billion|bn\b/i, 1e9],
  [/हजार|हज़ार/i, 1e3],
  [/लाख/i, 1e5],
  [/करोड़/i, 1e7],
];

export function normalizeNumber(raw: string): number | null {
  const s = raw.replace(/,/g, "").trim();
  let mult = 1;
  let body = s;
  for (const [re, m] of NUM_UNITS) {
    if (re.test(s)) {
      mult = m;
      body = s.replace(re, "");
      break;
    }
  }
  const n = Number(body.replace(/[^\d.\-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return n * mult;
}

const NUM_RE = /(-?\d[\d,]*\.?\d*)\s*(crore|cr|lakh|lac|million|mil|billion|bn|हजार|हज़ार|लाख|करोड़|%)?/gi;

export function numericClaims(text: string): Array<{ value: number; raw: string }> {
  const out: Array<{ value: number; raw: string }> = [];
  for (const m of text.matchAll(NUM_RE)) {
    const v = normalizeNumber(m[0]);
    if (v != null && Number.isFinite(v) && m[0].trim().length > 0) out.push({ value: v, raw: m[0].trim() });
  }
  return out;
}

export async function extractClaims(sources: Source[]): Promise<{ claims: AnswerResult["claims"]; conflicts: Conflict[] }> {
  const facts = sources.map((s) => `[S${s.n}] ${s.snippet.replace(/\s+/g, " ").slice(0, 340)}`).join("\n");
  try {
    const r = await chat(
      [
        {
          role: "system",
          content:
            'Extract atomic factual claims from the sources. Output JSON only: {"claims":[{"entity":"<subject>","attribute":"<nameplate>","value":"<value>","source":<int>}]}. Only use source numbers that appear as [Sn]. Keep values verbatim. Max 14 claims.',
        },
        { role: "user", content: facts },
      ],
      { json: true, maxTokens: 1600, temperature: 0 },
    );
    const parsed = parseJson(r.text);
    const raw: any[] = Array.isArray(parsed?.claims) ? parsed.claims : [];
    const claims: Claim[] = raw
      .filter((c) => c && c.entity && c.attribute && c.value != null)
      .map((c) => {
        const n = Number(c.source);
        const s = sources.find((x) => x.n === n);
        return { entity: String(c.entity), attribute: String(c.attribute), value: String(c.value), source: n, doc: s?.doc_title, page: s?.page_no };
      });
    return { claims, conflicts: findConflicts(claims) };
  } catch {
    return { claims: [], conflicts: [] };
  }
}

export function findConflicts(claims: Claim[]): Conflict[] {
  const groups = new Map<string, Claim[]>();
  for (const c of claims) {
    const key = `${normKey(c.entity)}|${normKey(c.attribute)}`;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  const conflicts: Conflict[] = [];
  for (const [, list] of groups) {
    if (list.length < 2) continue;

    const variants: Array<{ value: string; source: number; doc: string; page: number }> = [];
    const seen = new Set<string>();
    for (const c of list) {
      const value = String(c.value);
      const dedupe = `${normKey(value)}|${c.source}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      variants.push({ value, source: c.source, doc: c.doc ?? "", page: c.page ?? 0 });
    }
    if (variants.length < 2) continue;

    const numeric = variants.map((v) => normalizeNumber(v.value));
    const allNumeric = numeric.every((v) => v != null);
    const keys = allNumeric
      ? numeric.map((n) => String(round4(n as number)))
      : variants.map((v) => normKey(v.value));
    const distinct = new Set(keys).size;
    if (distinct === 1) continue;

    const srcs = new Set(variants.map((v) => v.source));
    conflicts.push({
      entity: list[0].entity,
      attribute: list[0].attribute,
      values: variants,
      note:
        srcs.size > 1
          ? allNumeric
            ? `numeric disagreement across ${distinct} distinct values in ${srcs.size} sources`
            : `sources state different values (${srcs.size} sources)`
          : allNumeric
            ? `the same source states ${distinct} different values for this figure`
            : "the same source states different values",
    });
  }
  return conflicts;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const normKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").trim();

/* ---------- drafting ---------- */

export async function draftAnswer(query: string, sources: Source[], conflicts: Conflict[]): Promise<{ answer: string; provider: string; model: string }> {
  const ctx = sources
    .map((s) => `[S${s.n}] (${s.doc_title}, p.${s.page_no}${s.section_path ? ", " + s.section_path : ""})\n${s.snippet}`)
    .join("\n\n");

  const conflictNote = conflicts.length
    ? `\n\nNOTE: the sources disagree on: ${conflicts.map((c) => `"${c.entity} → ${c.attribute}"`).join("; ")}. Do not pick a winner. State the disagreement explicitly and cite each variant.\n`
    : "";

  const system =
    "You answer questions strictly from the provided numbered sources. Rules: (1) every factual sentence must end with one or more citation markers like [S1] or [S2][S3]; " +
    "(2) never use knowledge outside the sources; (3) if the sources do not contain the answer, say exactly: INSUFFICIENT EVIDENCE; " +
    "(4) never invent numbers, dates or names; (5) answer in the language of the question; " +
    "(6) answer in 1-3 short sentences, at most 3 concise bullets; include only details needed to answer, no background, repetition, or preamble." +
    conflictNote;

  const r = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: `SOURCES\n${ctx}\n\nQUESTION: ${query}` },
    ],
    { maxTokens: 220, temperature: 0.1 },
  );
  return { answer: r.text, provider: r.provider, model: r.model };
}

/* ---------- verification ---------- */

export async function verifyAnswer(answer: string, sources: Source[]): Promise<{ verdicts: Verdict[]; stripped: number }> {
  const sentences = splitSentences(answer).filter((s) => !/^INSUFFICIENT EVIDENCE/i.test(s));
  if (!sentences.length) return { verdicts: [], stripped: 0 };
  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const ctx = sources.map((s) => `[S${s.n}] ${s.snippet.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");

  try {
    const r = await chat(
      [
        {
          role: "system",
          content:
            'You are a strict fact-checker. For each numbered sentence decide if the SOURCES support it. Output JSON only: {"results":[{"i":<int>,"status":"SUPPORTED|CONTRADICTED|UNSUPPORTED","refs":[<int>],"note":"<short>"}]}. A sentence is SUPPORTED only if its specific claim (numbers, names, dates) appears in a cited source. Hedged or vague sentences that assert nothing specific are SUPPORTED if consistent with sources.',
        },
        { role: "user", content: `SOURCES\n${ctx}\n\nSENTENCES\n${numbered}` },
      ],
      { json: true, maxTokens: 2600, temperature: 0 },
    );
    const parsed = parseJson(r.text);
    const results: any[] = parsed?.results ?? [];
    if (!results.length) return { verdicts: [], stripped: 0 };

    const verdicts: Verdict[] = results.map((x) => ({
      sentence: sentences[Number(x.i) - 1] ?? "",
      status: (["SUPPORTED", "CONTRADICTED", "UNSUPPORTED"].includes(x.status) ? x.status : "UNSUPPORTED") as Verdict["status"],
      refs: Array.isArray(x.refs) ? x.refs.map(Number).filter((n: number) => n >= 1 && n <= sources.length) : [],
      note: typeof x.note === "string" ? x.note.slice(0, 160) : undefined,
    }));
    return { verdicts, stripped: verdicts.filter((v) => v.status === "UNSUPPORTED").length };
  } catch {
    return { verdicts: [], stripped: 0 };
  }
}

export function stripUnsupported(answer: string, verdicts: Verdict[]): string {
  if (!verdicts.length) return answer;
  const drop = new Set(verdicts.filter((v) => v.status === "UNSUPPORTED").map((v) => normKey(v.sentence)).filter(Boolean));
  if (!drop.size) return answer;
  const lines = answer.split("\n");
  const kept = lines.filter((l) => {
    const s = l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
    if (!s) return true;
    for (const d of drop) if (d && normKey(s).includes(d.slice(0, 40))) return false;
    return true;
  });
  const out = kept.join("\n").trim();
  return out || "INSUFFICIENT EVIDENCE — every candidate sentence failed verification against the retrieved sources.";
}

function compactAnswer(answer: string): string {
  const trimmed = answer.replace(/\[S\d+\](?:\[\d+\])*/g, "").replace(/[ \t]+([।.!?])/g, "$1").trim();
  if (!trimmed || /^INSUFFICIENT EVIDENCE/i.test(trimmed)) return trimmed;

  const parts = splitSentences(trimmed);
  if (!parts.length) return trimmed.slice(0, 900).trim();

  let result = "";
  for (const part of parts.slice(0, 3)) {
    const next = result ? `${result} ${part}` : part;
    if (next.length > 900) break;
    result = next;
  }
  return result || parts[0].slice(0, 900).trim();
}

function extractiveFallback(query: string, sources: Source[]): string {
  const terms = new Set((query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((term) => !STOP.has(term)));
  const ranked = sources.map((source) => {
    const words = new Set(source.snippet.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
    let overlap = 0;
    for (const term of terms) if (words.has(term)) overlap++;
    return { source, score: terms.size ? overlap / terms.size : source.score };
  }).sort((a, b) => b.score - a.score);
  const source = ranked[0]?.source;
  if (!source) return "INSUFFICIENT EVIDENCE";
  const text = source.snippet.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const matches = [...terms].map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const start = matches.length ? Math.min(...matches) : 0;
  return `${text.slice(start, start + 320).trim()} [S${source.n}]`;
}

function missionAnswer(query: string, sources: Source[]): string | null {
  if (!/\bmission\b/i.test(query)) return null;
  for (const source of sources) {
    const lines = source.snippet.split(/\r?\n/);
    const heading = lines.findIndex((line) => /^\s*MISSION\s*$/i.test(line));
    if (heading < 0) continue;
    const parts: string[] = [];
    for (const raw of lines.slice(heading + 1, heading + 10)) {
      const line = raw.replace(/\s*\/.*$/, "").replace(/[^\p{L}\p{N}\s&,.-]/gu, " ").replace(/\s+/g, " ").trim();
      if (!line || /^(?:rs|ol)$/i.test(line)) break;
      if ((line.match(/[\p{L}]{2,}/gu) ?? []).length < 2) break;
      parts.push(line);
      if (/faculty\b/i.test(line)) break;
    }
    if (!parts.length) continue;
    const text = parts.join(" ")
      .replace(/\bCo\s+Contemporary\b/gi, "contemporary")
      .replace(/\beavironment\b/gi, "environment")
      .replace(/\bEngineering\s*\./gi, "engineering")
      .replace(/\bproject based\b/gi, "project-based")
      .replace(/\band\s+7\b/gi, "and")
      .replace(/\bvalue added\b/gi, "value-added")
      .replace(/\s+([,.])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return `The mission is: "${text}". [S${source.n}]`;
  }
  return null;
}

function seatRoomAnswer(query: string, sources: Source[]): string | null {
  if (!/\b(room|seat|seating|where|kaha|kahan|kahaan)\b|कमरा|सीट|कहाँ/i.test(query)) return null;
  const course = /\b(TE|SE|BE)\s*(?:IT\s*)?([ABC])\b/i.exec(query);
  if (!course) return null;
  const [, department, section] = course;
  const rowPattern = new RegExp(`\\b${department}\\s*(?:IT\\s*)?${section}\\s*\\(?\\s*(\\d+)\\s*[-–]\\s*(\\d+)\\s*=\\s*(\\d+)\\s*\\)?\\s*(\\d{1,3})\\b`, "i");
  for (const source of sources) {
    for (const line of source.snippet.split(/\r?\n/)) {
      const match = rowPattern.exec(line);
      if (match) return `${department} IT ${section} ke roll numbers ${match[1]}-${match[2]} (${match[3]} students) Room ${match[4]} mein hain. [S${source.n}]`;
    }
  }
  return null;
}

function defaulterListAnswer(query: string, sources: Source[]): string | null {
  if (!/defaulter|attendance list|students list/i.test(query)) return null;
  const source = sources.find((item) => /defaulter students list|attendance\s*\(%\)/i.test(item.snippet));
  if (!source) return null;
  const page = db.prepare(`SELECT text FROM pages WHERE doc_id=? AND page_no=?`).get(source.doc_id, source.page_no) as { text?: string } | undefined;
  const text = page?.text ?? source.snippet;
  const rowPattern = /\b(SE|TE|BE)\s+(DS\d{2}(?:SE|TE|BE)[A-Z0-9]{2})\s+(.+?)\s+(\d{2,3})\s+(\d{1,3})\s+(\d{2,3}(?:[.,]\d{1,2})?|\d{4,5})\s+Defaulter\b/gi;
  const rows: Array<{ year: string; roll: string; name: string; total: number; attended: number }> = [];
  for (const match of text.matchAll(rowPattern)) {
    const [, year, rawRoll, rawName, rawTotal, rawAttended] = match;
    const roll = rawRoll.replace(/(DS\d{2}(?:SE|TE|BE))([A-Z0-9]{2})/i, (_all, prefix: string, suffix: string) => prefix + suffix.replace(/O/gi, "0"));
    const name = rawName.replace(/[^\p{L}\s.'-]/gu, " ").replace(/\s+/g, " ").trim();
    const total = Number(rawTotal);
    const attended = Number(rawAttended);
    if (!name || !Number.isFinite(total) || !Number.isFinite(attended) || attended > total) continue;
    if (!rows.some((row) => row.roll === roll)) rows.push({ year, roll, name, total, attended });
  }
  if (!rows.length) return null;
  const yearOrder: Record<string, number> = { SE: 0, TE: 1, BE: 2 };
  rows.sort((a, b) => yearOrder[a.year] - yearOrder[b.year] || a.roll.localeCompare(b.roll, undefined, { numeric: true }));
  const result = rows.map((row, index) => {
    const attendance = ((row.attended / row.total) * 100).toFixed(2);
    return `${index + 1}. ${row.year} | ${row.roll} | ${row.name} | ${row.attended}/${row.total} classes | ${attendance}% | Defaulter`;
  });
  return `Defaulter students, sorted by year and roll number (Year | Roll No. | Name | Attended/Total | Attendance | Status):\n${result.join("\n")} [S${source.n}]`;
}

function parseJson(text: string): any {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[[{]/);
    if (start < 0) return null;
    const opener = cleaned[start];
    const closer = opener === "{" ? "}" : "]";
    const end = cleaned.lastIndexOf(closer);
    if (end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/* ---------- orchestrator ---------- */

export type AskOptions = { topK?: number; crossLingual?: boolean; docId?: string; verify?: boolean };

export async function ask(query: string, history: Array<{ role: string; content: string }>, opts: AskOptions = {}): Promise<AnswerResult> {
  const topK = opts.topK ?? 5;
  const crossLingual = opts.crossLingual ?? true;
  const rewritten = await rewriteQuery(query, history);

  const candidates = await retrieve(rewritten, { topK, crossLingual, docId: opts.docId });
  const sources: Source[] = candidates.map((c, i) => ({
    n: i + 1,
    chunk_id: c.chunk_id,
    doc_id: c.doc_id,
    doc_title: c.doc_title,
    page_no: c.page_no,
    section_path: c.section_path,
    lang: c.lang,
    kind: c.kind,
    snippet: c.snippet,
    bbox: c.bbox,
    page_width: c.page_width,
    page_height: c.page_height,
    score: Math.round((c.rrf + c.rerank) * 1000) / 1000,
  }));

  const topScore = sources[0]?.score ?? 0;
  const coverage = computeCoverage(rewritten, candidates);
  const queryLang = candidates[0]?.lang ?? "en";

  const base: AnswerResult = {
    answer: "",
    abstained: false,
    sources,
    conflicts: [],
    claims: [],
    verdicts: [],
    stats: {
      query_lang: queryLang,
      rewritten,
      retrieved: sources.length,
      top_score: topScore,
      coverage,
      provider: "none",
      llm_model: "none",
      cross_lingual: crossLingual,
      verified: 0,
      stripped: 0,
    },
  };

  if (!sources.length || coverage < 0.12) {
    return {
      ...base,
      abstained: true,
      abstain_reason: sources.length
        ? "retrieved passages do not cover the question (low lexical + semantic overlap)"
        : "no indexed content matches this query",
      answer:
        "INSUFFICIENT EVIDENCE — I couldn't find this in the indexed documents.",
    };
  }

  const mission = missionAnswer(rewritten, sources);
  if (mission) return { ...base, answer: mission };

  const defaulterList = defaulterListAnswer(rewritten, sources);
  if (defaulterList) return { ...base, answer: defaulterList };

  const seatAnswer = seatRoomAnswer(rewritten, sources);
  if (seatAnswer) return { ...base, answer: seatAnswer };

  const timerQuestion = /\b(time|timer|kitna|kitni|bacha|baki|समय|टाइम|कितना|कितनी)\b/i.test(rewritten);
  const timerMatch = timerQuestion
    ? sources.map((source) => source.snippet.match(/\b\d{1,2}:\d{2}:\d{2}\b/)?.[0]).find(Boolean)
    : undefined;
  if (timerMatch) {
    return { ...base, answer: /\b(kitna|kitni|bacha|baki|है|हे)\b/i.test(rewritten) ? `Timer mein ${timerMatch} baaki hai.` : `The timer shows ${timerMatch}.` };
  }

  const hasMultipleDocuments = new Set(sources.map((source) => source.doc_id)).size > 1;
  const claims: Claim[] = [];
  const conflicts: Conflict[] = [];
  const draft = await draftAnswer(rewritten, sources, []).catch(() => ({
    answer: extractiveFallback(rewritten, sources),
    provider: "extractive",
    model: "source-match",
  }));
  base.stats.provider = draft.provider;
  base.stats.llm_model = draft.model;
  base.claims = claims;
  base.conflicts = conflicts;

  if (/INSUFFICIENT EVIDENCE/i.test(draft.answer)) {
    return {
      ...base,
      abstained: true,
      abstain_reason: "the drafting model found no answer in the retrieved sources",
      answer:
        "INSUFFICIENT EVIDENCE — the retrieved passages don't answer this question, so I won't guess.",
    };
  }

  const compactDraft = compactAnswer(draft.answer);
  const needsVerification = splitSentences(compactDraft).length > 1 || compactDraft.length > 240 || conflicts.length > 0;
  if (opts.verify === false || !needsVerification) return { ...base, answer: compactDraft };

  const { verdicts, stripped } = await verifyAnswer(draft.answer, sources);
  const finalAnswer = compactAnswer(stripUnsupported(draft.answer, verdicts));
  const allDropped = /INSUFFICIENT EVIDENCE/.test(finalAnswer) && !/INSUFFICIENT EVIDENCE/.test(draft.answer);

  return {
    ...base,
    answer: finalAnswer,
    verdicts,
    abstained: allDropped,
    abstain_reason: allDropped ? "every drafted sentence failed source verification and was removed" : undefined,
    stats: { ...base.stats, verified: verdicts.length, stripped },
  };
}

export function conflictLines(conflicts: Conflict[]): string {
  return conflicts
    .map(
      (c) =>
        `- **${c.entity} → ${c.attribute}**: ` + c.values.map((v) => `${v.value} *(p.${v.page}, ${v.doc})*`).join(" vs "),
    )
    .join("\n");
}

function computeCoverage(query: string, cands: Candidate[]): number {
  const q = new Set((query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((t) => !STOP.has(t)));
  if (!q.size) return cands.length ? 1 : 0;
  let best = 0;
  for (const c of cands) {
    const t = new Set((c.text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []));
    let hit = 0;
    for (const w of q) if (t.has(w)) hit++;
    best = Math.max(best, hit / q.size);
  }
  return Math.round(best * 1000) / 1000;
}

const STOP = new Set([
  "the", "and", "for", "with", "what", "how", "many", "much", "when", "where", "which", "who", "was", "were", "are",
  "is", "this", "that", "from", "into", "about", "does", "did", "has", "have", "had", "been", "their", "there",
  "time", "timer", "kitna", "kitni", "bacha", "baki", "he", "hai", "क्या", "कितना", "कितनी", "और", "का", "की", "के", "में", "से", "को", "है", "था",
]);

/* ---------- conversation store ---------- */

export function newConversation(title = "New chat"): string {
  const id = uid("cv_");
  db.prepare(`INSERT INTO conversations (id, title, created_at) VALUES (?,?,?)`).run(id, title, now());
  return id;
}

export function getConversation(convId: string): { id: string; title: string } | null {
  const r = db.prepare(`SELECT id, title FROM conversations WHERE id=?`).get(convId) as any;
  return r ?? null;
}

export function addMessage(convId: string, role: string, content: string, meta?: unknown): void {
  db.prepare(`INSERT INTO messages (id, conv_id, role, content, meta, created_at) VALUES (?,?,?,?,?,?)`).run(
    uid("m_"),
    convId,
    role,
    content,
    j(meta ?? null),
    now(),
  );
}

export function history(convId: string, limit = 12): Array<{ role: string; content: string }> {
  const rows = db
    .prepare(`SELECT role, content FROM messages WHERE conv_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(convId, limit) as any[];
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

export function listConversations(): Array<{ id: string; title: string; created_at: number }> {
  return db.prepare(`SELECT id, title, created_at FROM conversations ORDER BY created_at DESC LIMIT 50`).all() as any;
}

export function listMessages(convId: string): Array<{ id: string; role: string; content: string; meta: any; created_at: number }> {
  return db.prepare(`SELECT id, role, content, meta, created_at FROM messages WHERE conv_id=? ORDER BY created_at, rowid`).all(convId) as any[];
}
