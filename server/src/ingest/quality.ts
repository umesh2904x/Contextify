export type PageSignals = {
  charCount: number;
  alphaRatio: number;
  replacementRatio: number;
  digitRatio: number;
  imageAreaRatio: number;
  fontCount: number;
  monoFontRatio: number;
  tinyTextRatio: number;
  widthPt: number;
  heightPt: number;
  rotation: number;
  hasInvisibleFont: boolean;
  wordCount: number;
  avgWordLen: number;
  tableSignal: number;
};

export type Quality = {
  score: number;
  route: "text-layer" | "vision-ocr" | "vision-table" | "vision-noisy";
  reasons: string[];
  signals: PageSignals;
};

export function emptySignals(widthPt = 612, heightPt = 792): PageSignals {
  return {
    charCount: 0,
    alphaRatio: 0,
    replacementRatio: 0,
    digitRatio: 0,
    imageAreaRatio: 0,
    fontCount: 0,
    monoFontRatio: 0,
    tinyTextRatio: 0,
    widthPt,
    heightPt,
    rotation: 0,
    hasInvisibleFont: false,
    wordCount: 0,
    avgWordLen: 0,
    tableSignal: 0,
  };
}

const REPLACEMENT = /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function scorePage(s: PageSignals): Quality {
  const reasons: string[] = [];
  const area = Math.max(1, s.widthPt * s.heightPt);
  const expected = area / 3200; // ~ chars a dense A4 text page has

  let score = 0;
  const density = Math.min(1.6, s.charCount / expected);

  if (s.charCount < 40) {
    score -= 0.55;
    reasons.push(`almost no text layer (${s.charCount} chars)`);
  } else if (s.charCount < 180) {
    score -= 0.25;
    reasons.push(`thin text layer (${s.charCount} chars)`);
  } else {
    score += Math.min(0.4, density * 0.28);
  }

  if (s.imageAreaRatio > 0.55) {
    score -= 0.4;
    reasons.push(`page is ${Math.round(s.imageAreaRatio * 100)}% raster image → scan`);
  } else if (s.imageAreaRatio > 0.2) {
    score -= 0.12;
    reasons.push("noticeable raster area");
  }

  if (s.replacementRatio > 0.02) {
    score -= 0.35;
    reasons.push(`${Math.round(s.replacementRatio * 100)}% broken glyphs (broken font encoding)`);
  }

  if (s.hasInvisibleFont) {
    score -= 0.5;
    reasons.push("invisible/OCR-invisible font detected (scanned PDF with hidden text)");
  }

  if (s.monoFontRatio > 0.7 && s.charCount > 60) {
    score -= 0.1;
    reasons.push("monospaced / fax-style font");
  }

  if (s.tinyTextRatio > 0.5 && s.charCount > 200) {
    score -= 0.08;
    reasons.push("mostly sub-5pt glyphs (fax noise)");
  }

  if (s.rotation !== 0) {
    score -= 0.18;
    reasons.push(`page rotated ${s.rotation}°`);
  }

  if (s.avgWordLen > 0 && s.avgWordLen < 2.2 && s.wordCount > 25) {
    score -= 0.15;
    reasons.push("word lengths look like OCR noise");
  }

  if (s.tableSignal > 0.35) {
    reasons.push(`table-like alignment (${Math.round(s.tableSignal * 100)}%)`);
  }

  score = Math.max(0, Math.min(1, score));

  const noisy = s.replacementRatio > 0.02 || s.monoFontRatio > 0.7 || s.tinyTextRatio > 0.5 || s.rotation !== 0;
  let route: Quality["route"];
  if (score >= 0.35) route = "text-layer";
  else if (s.tableSignal > 0.35) route = "vision-table";
  else if (noisy) route = "vision-noisy";
  else route = "vision-ocr";

  return { score, route, reasons, signals: s };
}

export function summarize(sig: PageSignals, text: string): void {
  const chars = text.length;
  sig.charCount = chars;
  const bad = text.match(REPLACEMENT)?.length ?? 0;
  sig.replacementRatio = chars ? bad / chars : 0;
  const words = text.split(/\s+/).filter(Boolean);
  sig.wordCount = words.length;
  sig.avgWordLen = words.length ? words.reduce((a, w) => a + w.length, 0) / words.length : 0;
  sig.digitRatio = chars ? (text.match(/\d/g)?.length ?? 0) / chars : 0;
  sig.alphaRatio = chars ? (text.match(/[\p{L}\p{N}\p{P}\s]/gu)?.length ?? 0) / chars : 0;
}
