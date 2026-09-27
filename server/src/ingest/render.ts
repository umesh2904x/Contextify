import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { RENDER_DIR, RENDER_SCALE } from "../config.js";

type PdfPage = any;

const renderCache = new Map<string, Promise<string>>();

export function renderPathFor(docId: string, pageNo: number): string {
  return resolve(RENDER_DIR, docId, `p${String(pageNo).padStart(4, "0")}.png`);
}

export async function renderPageToPng(page: PdfPage, docId: string, pageNo: number): Promise<string> {
  const key = `${docId}:${pageNo}`;
  const hit = renderCache.get(key);
  if (hit) return hit;
  const out = renderPathFor(docId, pageNo);
  if (existsSync(out)) {
    renderCache.set(key, Promise.resolve(out));
    return out;
  }
  const task = (async () => {
    const vp = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    try {
      await page.render({ canvasContext: ctx as any, viewport: vp, canvas: canvas as any }).promise;
    } catch {
      /* some pages fail to render; we still keep a blank render so UI never breaks */
    }
    mkdirSync(resolve(RENDER_DIR, docId), { recursive: true });
    writeFileSync(out, canvas.toBuffer("image/png"));
    return out;
  })();
  renderCache.set(key, task);
  return task;
}

export function pagePixelSize(pageNo: number, docId: string): { w: number; h: number } | null {
  void pageNo;
  void docId;
  return null;
}
