import { uid } from "../db.js";
import type { PageExtraction, TextItem } from "./pdf.js";

export type ChunkDraft = {
  id: string;
  doc_id: string;
  page_no: number;
  ord: number;
  text: string;
  kind: "text" | "table" | "heading";
  section_path: string;
  bbox: Array<[number, number, number, number]>;
  meta?: Record<string, unknown>;
};

const TARGET = 420;
const MAX = 650;
const OVERLAP_LINES = 1;

type Block = { text: string; items: TextItem[]; isHeading: boolean; size: number };

function headingTexts(page: PageExtraction): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of page.headings) m.set(h.text.toLowerCase(), h.size);
  return m;
}

function classify(page: PageExtraction, line: string, items: TextItem[], hmap: Map<string, number>): Block {
  const key = line.toLowerCase();
  const size = hmap.get(key);
  const maxSize = items.length ? Math.max(...items.map((i) => i.h)) : 0;
  if (size != null || /^(chapter|section|part|annex|appendix|table|figure|fig\.|sr no|क्रमांक)\b/i.test(line)) {
    return { text: line, items, isHeading: true, size: maxSize };
  }
  if (items.length && line.length < 80 && /^\s*(\d+(\.\d+)*\s+)?[A-Z]/.test(line) && !/[.;,]$/.test(line) && maxSize > 0) {
    return { text: line, items, isHeading: true, size: maxSize };
  }
  return { text: line, items, isHeading: false, size: maxSize };
}

function unionBox(items: TextItem[]): Array<[number, number, number, number]> {
  if (!items.length) return [];
  const x0 = Math.min(...items.map((i) => i.x));
  const y0 = Math.min(...items.map((i) => i.y));
  const x1 = Math.max(...items.map((i) => i.x + i.w));
  const y1 = Math.max(...items.map((i) => i.y + i.h));
  return [[round(x0), round(y0), round(x1 - x0), round(y1 - y0)]];
}

const round = (n: number) => Math.round(n * 10) / 10;

export function chunkPage(docId: string, pageNo: number, page: PageExtraction, startOrd: number): ChunkDraft[] {
  const out: ChunkDraft[] = [];
  let ord = startOrd;
  const hmap = headingTexts(page);
  const lines = page.lines.length ? page.lines : (page.text ? page.text.split("\n") : []);

  const blocks: Block[] = lines.map((line) => {
    const b = classify(page, line, [], hmap);
    return b;
  });
  reattachItems(blocks, page);

  const sectionStack: string[] = [];
  let buf: Block[] = [];
  const flush = (kind: ChunkDraft["kind"] = "text") => {
    if (!buf.length) return;
    const text = buf.map((b) => b.text).join("\n").trim();
    if (text.length >= 40) {
      out.push({
        id: uid("c_"),
        doc_id: docId,
        page_no: pageNo,
        ord: ord++,
        text,
        kind,
        section_path: sectionStack.join(" › "),
        bbox: unionBox(buf.flatMap((b) => b.items)),
        meta: { charCount: text.length },
      });
    }
    buf = [];
  };

  for (const b of blocks) {
    if (b.isHeading) {
      flush();
      if (sectionStack.length >= 3) sectionStack.shift();
      sectionStack.push(b.text.replace(/\s+/g, " ").trim().slice(0, 120));
      out.push({
        id: uid("c_"),
        doc_id: docId,
        page_no: pageNo,
        ord: ord++,
        text: `${sectionStack.join(" › ")}\n${b.text}`,
        kind: "heading",
        section_path: sectionStack.join(" › "),
        bbox: unionBox(b.items),
      });
      continue;
    }
    buf.push(b);
    const len = buf.reduce((a, x) => a + x.text.length + 1, 0);
    if (len >= TARGET) {
      const carry = buf.slice(-OVERLAP_LINES);
      flush();
      buf = carry;
    }
    if (len > MAX) flush();
  }
  flush();
  return out;
}

/** `lines` and `lineItems` come from the same grouping pass, so index i of each belongs together. */
function reattachItems(blocks: Block[], page: PageExtraction): void {
  if (!page.lineItems?.length || page.lineItems.length !== blocks.length) return;
  for (const [i, b] of blocks.entries()) b.items = page.lineItems[i] ?? [];
}

/* ---------------- tables ---------------- */

export function chunkTableHtml(docId: string, pageNo: number, html: string, sectionPath: string, startOrd: number, page?: PageExtraction): ChunkDraft[] {
  const out: ChunkDraft[] = [];
  let ord = startOrd;
  const rows = parseHtmlRows(html);
  if (!rows.length) return out;
  const header = rows[0];
  const body = rows.slice(1);
  const sectionLine = sectionPath ? `${sectionPath}` : "";

  out.push({
    id: uid("c_"),
    doc_id: docId,
    page_no: pageNo,
    ord: ord++,
    text: `TABLE (${header.length} columns)\nColumns: ${header.join(" | ")}\nRows: ${body.length}`,
    kind: "table",
    section_path: sectionPath,
    bbox: page ? [] : [],
    meta: { table: true, cols: header.length, rows: body.length },
  });

  for (const r of body) {
    const cells = padRow(r, header.length);
    const lines = header.map((h, i) => `${h}: ${cells[i] ?? ""}`);
    const text = `${sectionLine ? sectionLine + "\n" : ""}TABLE ROW\n${lines.join("\n")}`;
    if (text.trim().length < 20) continue;
    out.push({
      id: uid("c_"),
      doc_id: docId,
      page_no: pageNo,
      ord: ord++,
      text,
      kind: "table",
      section_path: sectionPath,
      bbox: page ? unionBox(page.items) : [],
      meta: { table: true, row: true, header, cells },
    });
  }
  return out;
}

function padRow(cells: string[], n: number): string[] {
  if (cells.length >= n) return cells.slice(0, n);
  return [...cells, ...Array(n - cells.length).fill("")];
}

export function parseHtmlRows(html: string): string[][] {
  const rows: string[][] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html))) {
    const cells: string[] = [];
    const cellRe = /<(t[hd])[^>]*>([\s\S]*?)<\/\1>/gi;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(m[1]))) {
      const span = /colspan\s*=\s*"?(\d+)/i.exec(c[0])?.[1];
      const txt = decodeEntities(c[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      cells.push(txt);
      if (span && Number(span) > 1) for (let k = 1; k < Number(span); k++) cells.push(txt);
    }
    if (cells.some((x) => x.length)) rows.push(cells);
  }
  return rows;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** Row lines that look tabular in a plain text page (no HTML from OCR). */
export function chunkPipeLines(docId: string, pageNo: number, lines: string[], sectionPath: string, startOrd: number): ChunkDraft[] {
  const out: ChunkDraft[] = [];
  let ord = startOrd;
  const tableLines = lines.filter((l) => l.includes("  |  "));
  if (tableLines.length < 3) return out;
  const header = tableLines[0].split("  |  ").map((s) => s.trim());
  const sectionLine = sectionPath ? `${sectionPath}\n` : "";
  const intro = tableLines
    .filter((l) => !/^[\d.,\s%()₹$€-]*$/.test(l))
    .slice(0, 2)
    .join(" ");
  out.push({
    id: uid("c_"),
    doc_id: docId,
    page_no: pageNo,
    ord: ord++,
    text: `${sectionLine}TABLE${intro ? `\n${intro}` : ""}\nColumns: ${header.join(" | ")}\nRows: ${tableLines.length - 1}`,
    kind: "table",
    section_path: sectionPath,
    bbox: [],
    meta: { table: true, cols: header.length, rows: tableLines.length - 1 },
  });
  for (const l of tableLines.slice(1)) {
    const cells = l.split("  |  ").map((s) => s.trim());
    const text = `${sectionLine}TABLE ROW\n${header.map((h, i) => `${h}: ${cells[i] ?? ""}`).join("\n")}`;
    if (text.length < 24) continue;
    out.push({
      id: uid("c_"),
      doc_id: docId,
      page_no: pageNo,
      ord: ord++,
      text,
      kind: "table",
      section_path: sectionPath,
      bbox: [],
      meta: { table: true, row: true, header, cells },
    });
  }
  return out;
}
