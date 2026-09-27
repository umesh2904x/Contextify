import { createRequire } from "node:module";
import { emptySignals, scorePage, summarize, type PageSignals, type Quality } from "./quality.js";

const require = createRequire(import.meta.url);
type PdfPage = any;
type PdfDoc = any;

let libPromise: Promise<any> | null = null;

async function pdfjs(): Promise<any> {
  if (!libPromise) {
    libPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((m: any) => ({
      lib: m,
      __OPS: Object.fromEntries(Object.entries(m.OPS ?? {}).map(([k, v]) => [k, Number(v)])),
    }));
  }
  return libPromise;
}

export async function loadPdf(bytes: Uint8Array): Promise<PdfDoc> {
  const { lib } = await pdfjs();
  return lib.getDocument({
    data: bytes,
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
}

export type TextItem = { str: string; x: number; y: number; w: number; h: number; font: string; eol: boolean };
export type Heading = { text: string; size: number };
export type PageExtraction = {
  pageNo: number;
  width: number;
  height: number;
  rotation: number;
  items: TextItem[];
  text: string;
  lines: string[];
  /** Glyph runs per line, index-aligned with `lines`, so chunks can claim their own page region. */
  lineItems: TextItem[][];
  headings: Heading[];
  signals: PageSignals;
  quality: Quality;
};

export async function extractPage(page: PdfPage, pageNo: number, m: any): Promise<PageExtraction> {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
  const styles: Record<string, any> = tc.styles ?? {};
  const signals = emptySignals(vp.width, vp.height);
  signals.rotation = page.rotate ?? 0;

  const items: TextItem[] = [];
  const fontSizes = new Map<string, number>();
  const fontNames = new Set<string>();

  for (const raw of tc.items as any[]) {
    if (typeof raw.str !== "string" || !raw.str.length) continue;
    const t: number[] = raw.transform;
    const size = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || raw.height || 10;
    const x = t[4];
    const baselineY = t[5];
    const yTop = vp.height - baselineY - size * 0.82;
    const w = raw.width ?? raw.str.length * size * 0.5;
    items.push({ str: raw.str, x, y: yTop, w, h: size, font: raw.fontName ?? "F0", eol: !!raw.hasEOL });
    fontSizes.set(raw.fontName ?? "F0", size);
    fontNames.add(raw.fontName ?? "F0");
  }

  signals.fontCount = fontNames.size;
  const monoCount = [...fontNames].filter((f) => /mono|courier|consol/i.test(String(styles[f]?.fontFamily ?? ""))).length;
  signals.monoFontRatio = fontNames.size ? monoCount / fontNames.size : 0;
  const tiny = items.filter((i) => i.h < 5).length;
  signals.tinyTextRatio = items.length ? tiny / items.length : 0;

  const lines = groupLines(items, vp.height);
  const text = lines.map((l) => l.text).join("\n");
  summarize(signals, text);

  const sizes = [...fontSizes.values()].sort((a, b) => b - a);
  const bodySize = sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.6))] : 10;
  const headings: Heading[] = [];
  for (const l of lines) {
    if (l.items.length === 0) continue;
    const maxSize = Math.max(...l.items.map((i) => i.h));
    const clean = l.text.trim();
    if (!clean || clean.length > 110) continue;
    if (maxSize >= bodySize * 1.18 || (maxSize >= bodySize * 1.08 && clean.length < 70)) {
      headings.push({ text: clean, size: maxSize });
    }
  }

  signals.tableSignal = tableSignal(lines);

  const ops = await scanOperators(page, m);
  signals.imageAreaRatio = ops.imageRatio;
  signals.hasInvisibleFont = ops.invisibleChars > 8 && ops.invisibleChars / Math.max(1, text.replace(/\s/g, "").length) > 0.25;

  const quality = scorePage(signals);
  return { pageNo, width: vp.width, height: vp.height, rotation: signals.rotation, items, text, lines: lines.map((l) => l.text), lineItems: lines.map((l) => l.items), headings, signals, quality };
}

type Line = { y: number; items: TextItem[]; text: string; x0: number; x1: number };

function groupLines(items: TextItem[], pageH: number): Line[] {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => (Math.abs(a.y - b.y) > 2 ? a.y - b.y : a.x - b.x));
  const out: Line[] = [];
  let cur: Line | null = null;
  for (const it of sorted) {
    if (cur && Math.abs(it.y - cur.y) <= Math.max(2.2, cur.items[0].h * 0.55)) {
      cur.items.push(it);
    } else {
      if (cur) out.push(cur);
      cur = { y: it.y, items: [it], text: "", x0: it.x, x1: it.x + it.w };
    }
  }
  if (cur) out.push(cur);

  for (const l of out) {
    l.items.sort((a, b) => a.x - b.x);
    let text = "";
    let prev: TextItem | null = null;
    for (const it of l.items) {
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        const space = gap > it.h * 0.16;
        if (gap > it.h * 3.2) text += "  |  ";
        else if (space) text += " ";
      }
      text += it.str;
      prev = it;
    }
    l.text = text.replace(/[ \t]+/g, " ").trim();
    l.x0 = Math.min(...l.items.map((i) => i.x));
    l.x1 = Math.max(...l.items.map((i) => i.x + i.w));
  }
  return out.filter((l) => l.text.length > 0);
}

function tableSignal(lines: Line[]): number {
  if (lines.length < 6) return 0;
  let multi = 0;
  for (const l of lines) {
    if (l.items.length < 3) continue;
    let gaps = 0;
    for (let i = 1; i < l.items.length; i++) {
      const gap = l.items[i].x - (l.items[i - 1].x + l.items[i - 1].w);
      if (gap > 14) gaps++;
    }
    if (gaps >= 2) multi++;
  }
  return Math.min(1, multi / Math.max(6, lines.length * 0.55));
}

async function scanOperators(page: PdfPage, m: any): Promise<{ imageRatio: number; invisibleChars: number }> {
  const OPS = m.__OPS as Record<string, number>;
  const inv = (name: string): number => OPS[name] ?? -1;
  let ops: any;
  try {
    ops = await page.getOperatorList();
  } catch {
    return { imageRatio: 0, invisibleChars: 0 };
  }
  const fnArray = ops.fnArray as number[];
  const argsArray = ops.argsArray as any[][];

  const stack: number[][] = [[1, 0, 0, 1, 0, 0]];
  let ctm = [1, 0, 0, 1, 0, 0];
  let painted = 0;
  let invisible = 0;
  let tr = 0;

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const a = argsArray[i] ?? [];
    if (fn === inv("save")) {
      stack.push(ctm.slice());
    } else if (fn === inv("restore")) {
      ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (fn === inv("transform")) {
      ctm = mul(ctm, a as number[]);
    } else if (fn === inv("setTextRenderingMode")) {
      tr = Number(a[0] ?? 0);
    } else if (fn === inv("showText") || fn === inv("showSpacedText")) {
      const s = String(a[0] ?? "");
      if (tr === 3 || tr === 7) invisible += s.trim().length;
    } else if (fn === inv("paintImageXObject") || fn === inv("paintInlineImage")) {
      const w = Number(a?.[a.length - 2] ?? 0);
      const h = Number(a?.[a.length - 1] ?? 0);
      const area = Math.abs(w * ctm[0] * h * ctm[3]);
      if (Number.isFinite(area) && area > 0) painted += area;
    }
  }
  const vp = page.getViewport({ scale: 1 });
  const ratio = Math.min(1, painted / (vp.width * vp.height || 1));
  return { imageRatio: ratio, invisibleChars: invisible };
}

function mul(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function linesFromText(text: string): string[] {
  return text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
}
