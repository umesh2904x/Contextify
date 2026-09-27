import { getLocalAccessBearer, supabase } from "./auth";

export type Bbox = [number, number, number, number];

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
  bbox: Bbox[];
  page_width: number;
  page_height: number;
  score: number;
};

export type Conflict = {
  entity: string;
  attribute: string;
  values: Array<{ value: string; source: number; doc: string; page: number }>;
  note?: string;
};

export type Verdict = { sentence: string; status: "SUPPORTED" | "CONTRADICTED" | "UNSUPPORTED"; refs: number[]; note?: string };

export type AskResult = {
  conversation_id: string;
  answer: string;
  abstained: boolean;
  abstain_reason?: string;
  sources: Source[];
  conflicts: Conflict[];
  claims: Array<{ entity: string; attribute: string; value: string; source: number }>;
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
  error?: string;
};

export type DocRow = {
  id: string;
  title: string;
  filename: string;
  mime: string;
  bytes: number;
  page_count: number;
  status: string;
  route: string;
  error: string | null;
  created_at: number;
  chunk_count: number;
  indexed_pages: number;
  private_files?: boolean;
};

export type Health = {
  ok: boolean;
  sarvam: boolean;
  ollama: boolean;
  embeddings: { mode: string; model: string; error: string };
  pending_jobs: number;
  corpus: { chunks: number; docs: number; vectors: number; langs: Array<{ lang: string; n: number }> };
};

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const localBearer = getLocalAccessBearer();
  if (localBearer) headers.set("Authorization", `Bearer ${localBearer}`);
  if (supabase) {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (data.session?.access_token) headers.set("Authorization", `Bearer ${data.session.access_token}`);
  }
  const res = await fetch(url, { ...init, headers });
  const txt = await res.text();
  let data: any = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = { error: txt.slice(0, 300) };
  }
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { data });
  return data as T;
}

export const api = {
  health: () => req<Health>("/api/health"),
  docs: () => req<{ documents: DocRow[] }>("/api/documents"),
  doc: (id: string) =>
    req<{
      document: any;
      pages: Array<{ page_no: number; width: number; height: number; char_count: number; lang: string; quality: number; engine: string; quality_json: any; has_render: boolean }>;
      chunks: Array<{ id: string; page_no: number; ord: number; kind: string; lang: string; section_path: string; preview: string; token_est: number }>;
    }>(`/api/documents/${id}`),
  del: (id: string) => req<{ ok: boolean }>(`/api/documents/${id}`, { method: "DELETE" }),
  rename: (id: string, title: string) => req<{ ok: boolean; title: string }>(`/api/documents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) }),
  rerun: (id: string) => req<{ ok: boolean }>(`/api/documents/${id}/rerun`),
  ask: (body: { query: string; conversation_id?: string; top_k?: number; cross_lingual?: boolean; verify?: boolean; document_id?: string }) =>
    req<AskResult>("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  conversations: () => req<{ conversations: Array<{ id: string; title: string; created_at: number }> }>("/api/conversations"),
  deleteConversation: (id: string) => req<{ ok: boolean }>(`/api/conversations/${id}`, { method: "DELETE" }),
  messages: (id: string) => req<{ messages: any[] }>(`/api/conversations/${id}/messages`),
  pageText: (id: string, page: number) => req<{ text: string; lang: string; engine: string; char_count: number }>(`/api/documents/${id}/page/${page}/text`),
  retrieve: (query: string, topK = 10, crossLingual = true) =>
    req<{ query: string; query_lang: string; results: any[] }>("/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, top_k: topK, cross_lingual: crossLingual }),
    }),
  upload: async (files: File[], onProgress?: (pct: number) => void, privateFiles = false) =>
    new Promise<{ documents: Array<{ id: string; filename: string; status: string }>; rejected?: Array<{ filename: string; error: string }> }>((resolve, reject) => {
      const fd = new FormData();
      fd.append("private_files", privateFiles ? "1" : "0");
      for (const f of files) fd.append("file", f, f.name);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        let data: any;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          reject(new Error("bad upload response"));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(data?.error ?? `HTTP ${xhr.status}`));
          return;
        }
        resolve(data);
      };
      xhr.onerror = () => reject(new Error("upload failed"));
      const headers = new Headers();
      void (async () => {
        const localBearer = getLocalAccessBearer();
        if (localBearer) headers.set("Authorization", `Bearer ${localBearer}`);
        if (supabase) {
          const { data, error } = await supabase.auth.getSession();
          if (error) throw error;
          if (data.session?.access_token) headers.set("Authorization", `Bearer ${data.session.access_token}`);
        }
        headers.forEach((value, key) => xhr.setRequestHeader(key, value));
        xhr.send(fd);
      })().catch(reject);
    }),
};

export const renderUrl = (docId: string, page: number) => `/api/documents/${docId}/render/${page}`;

export async function renderBlobUrl(docId: string, page: number): Promise<string> {
  const headers = new Headers();
  const localBearer = getLocalAccessBearer();
  if (localBearer) headers.set("Authorization", `Bearer ${localBearer}`);
  if (supabase) {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (data.session?.access_token) headers.set("Authorization", `Bearer ${data.session.access_token}`);
  }
  const url = renderUrl(docId, page);
  let response: Response;
  try {
    response = await fetch(url, { headers, cache: "force-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if ("caches" in window) {
      void window.caches.open("contextify-renders-v1")
        .then((cache) => cache.put(url, response.clone()))
        .catch(() => { /* Preview does not depend on browser cache storage. */ });
    }
  } catch (error) {
    if (!("caches" in window)) throw error;
    const cached = await window.caches.open("contextify-renders-v1").then((cache) => cache.match(url));
    if (!cached) throw error;
    response = cached;
  }
  return URL.createObjectURL(await response.blob());
}
