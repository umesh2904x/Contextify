import { readFileSync } from "node:fs";
import { OfficeParser, type OfficeChunk, type OfficeContentNode } from "officeparser";
import { db, j, now, uid } from "../db.js";
import { indexChunk } from "../retrieval.js";
import { heuristicLang } from "../providers/sarvam.js";

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odg: "application/vnd.oasis.opendocument.graphics",
  rtf: "application/rtf",
  csv: "text/csv",
  md: "text/markdown",
  html: "text/html",
  epub: "application/epub+zip",
  txt: "text/plain",
  json: "application/json",
  log: "text/plain",
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const PLAIN_TEXT_EXTENSIONS = new Set(["txt", "json", "log"]);
const CHUNK_LIMIT = 600;

export function fileExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

export function isSupportedUpload(filename: string): boolean {
  return Object.hasOwn(MIME_BY_EXTENSION, fileExtension(filename));
}

export function isRasterUpload(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(filename));
}

export function mimeForUpload(filename: string): string {
  return MIME_BY_EXTENSION[fileExtension(filename)] ?? "application/octet-stream";
}

type TextPage = { pageNo: number; title: string; text: string };

export async function ingestTextDocument(docId: string, path: string, filename: string): Promise<number> {
  const extension = fileExtension(filename);
  let pages: TextPage[];
  let officeChunks: OfficeChunk[] = [];
  let sourceType = extension;

  if (PLAIN_TEXT_EXTENSIONS.has(extension)) {
    pages = [{ pageNo: 1, title: "", text: readFileSync(path, "utf8").replace(/\u0000/g, "") }];
  } else {
    const ast = await OfficeParser.parseOffice(path, { extractAttachments: false, ignoreComments: true });
    sourceType = ast.type;
    const sections = ast.content.filter((node) => node.type === "slide" || node.type === "sheet");
    if (sections.length) {
      pages = sections.map((node, index) => {
        const title = node.type === "sheet" ? node.metadata?.sheetName ?? `Sheet ${index + 1}` : `Slide ${node.metadata?.slideNumber ?? index + 1}`;
        const notes = (node.notes ?? []).map(nodeText).filter(Boolean);
        const text = [nodeText(node), ...notes].filter(Boolean).join("\n");
        return { pageNo: node.type === "slide" ? node.metadata?.slideNumber ?? index + 1 : index + 1, title, text };
      });
    } else {
      const { value } = await ast.to("text");
      pages = [{ pageNo: 1, title: "", text: String(value ?? "") }];
    }

    const splitBy = ast.type === "pptx" || ast.type === "odp" ? "slide" : ast.type === "xlsx" || ast.type === "ods" ? "sheet" : "paragraph";
    const { value } = await ast.to("chunks", {
      chunksConfig: { strategy: "document-structure", splitBy, maxChunkSize: CHUNK_LIMIT, tableSplitStrategy: "row" },
    });
    officeChunks = Array.isArray(value) ? value : [];
  }

  const pageBySheet = new Map(pages.filter((page) => page.title).map((page) => [page.title, page.pageNo]));
  const pageByNumber = new Map(pages.map((page) => [page.pageNo, page]));
  for (const page of pages) {
    const text = page.text.trim();
    const language = text ? heuristicLang(text.slice(0, 400)) : null;
    db.prepare(
      `INSERT OR REPLACE INTO pages (id, doc_id, page_no, width, height, text, char_count, lang, quality, quality_json, engine, render_path, blocks)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(uid("p_"), docId, page.pageNo, 0, 0, text, text.length, language, text ? 1 : 0, j({ route: "document-text", sourceType, title: page.title }), "document-text", null, "[]");
  }

  let ord = 0;
  const fallbackChunks = plainTextChunks(pages);
  const officePageNumbers = new Set<number>();
  for (const chunk of officeChunks) {
    const meta = chunk.metadata;
    const sheetName = typeof meta.sheetName === "string" ? meta.sheetName : "";
    const pageNo = Number(meta.slideNumber ?? meta.pageNumber ?? (sheetName ? pageBySheet.get(sheetName) : undefined) ?? 1);
    const text = chunk.text.trim();
    if (!text) continue;
    await indexChunk({
      id: uid("c_"),
      doc_id: docId,
      page_no: pageNo,
      ord: ord++,
      text,
      kind: meta.isTableChunk ? "table" : "text",
      section_path: String(meta.closestHeading ?? sheetName ?? pageByNumber.get(pageNo)?.title ?? ""),
      bbox: [],
      meta: { ...meta, sourceType },
    });
    officePageNumbers.add(pageNo);
  }

  for (const page of pages) {
    if (officePageNumbers.has(page.pageNo)) continue;
    for (const text of fallbackChunks.filter((chunk) => chunk.pageNo === page.pageNo).map((chunk) => chunk.text)) {
      await indexChunk({
        id: uid("c_"), doc_id: docId, page_no: page.pageNo, ord: ord++, text, kind: "text", section_path: page.title, bbox: [], meta: { sourceType },
      });
    }
  }

  db.prepare(`UPDATE documents SET page_count=?, route='digital', status='queued', meta=?, updated_at=? WHERE id=?`).run(
    pages.length,
    j({ sourceType, pageTitles: pages.map((page) => page.title) }),
    now(),
    docId,
  );
  return pages.length;
}

function nodeText(node: OfficeContentNode): string {
  if (node.text?.trim()) return node.text.trim();
  return (node.children ?? []).map(nodeText).filter(Boolean).join("\n");
}

function plainTextChunks(pages: TextPage[]): Array<{ pageNo: number; text: string }> {
  const output: Array<{ pageNo: number; text: string }> = [];
  for (const page of pages) {
    const text = page.text.replace(/\r\n?/g, "\n").trim();
    if (!text) continue;
    const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    let buffer = "";
    for (const paragraph of paragraphs) {
      let remaining = paragraph;
      while (remaining.length > CHUNK_LIMIT) {
        const boundary = remaining.lastIndexOf(" ", CHUNK_LIMIT);
        const end = boundary > 0 ? boundary : CHUNK_LIMIT;
        if (buffer) output.push({ pageNo: page.pageNo, text: buffer });
        output.push({ pageNo: page.pageNo, text: remaining.slice(0, end).trim() });
        buffer = "";
        remaining = remaining.slice(end).trim();
      }
      if (buffer && buffer.length + remaining.length + 2 > CHUNK_LIMIT) {
        output.push({ pageNo: page.pageNo, text: buffer });
        buffer = "";
      }
      buffer = buffer ? `${buffer}\n\n${remaining}` : remaining;
    }
    if (buffer) output.push({ pageNo: page.pageNo, text: buffer });
  }
  return output;
}