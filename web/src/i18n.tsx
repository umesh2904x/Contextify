import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Languages, Loader2 } from "lucide-react";

export const UI_COPY = [
  "Website language",
  "Your documents, ready to answer",
  "A clearer way to work with your files",
  "Welcome back to Contextify.",
  "Make room for better answers.",
  "Keep important documents close, ask questions in your own words, and follow every answer back to its source.",
  "Your files, in one place",
  "Answers with source pages",
  "Your workspace",
  "Welcome back",
  "Sign in to pick up where you left off.",
  "Create your account",
  "Set up your account and start with your documents.",
  "Sign in",
  "Create account",
  "Login setup is incomplete.",
  "Account ID: 2904 · Password: 2904. Real accounts need login setup.",
  "Account creation needs login setup. Add your account settings to the local environment file and restart the app.",
  "Email or account ID",
  "Email",
  "you@example.com or 2904",
  "you@example.com",
  "Password",
  "Password or 2904",
  "At least 6 characters",
  "Account ID or password is incorrect.",
  "Account setup is not connected yet.",
  "Check your email to confirm your account, then sign in.",
  "Please wait…",
  "Sign in to Contextify",
  "Create my account",
  "A confirmation email may be required before your first sign-in.",
  "Opening your workspace…",
  "Sign out",
  "Document library",
  "documents",
  "chunks",
  "Upload documents",
  "PDF, PPTX, DOCX, XLSX, ODT/ODP/ODS, RTF, CSV, MD, HTML, EPUB, TXT/JSON, PNG/JPG/GIF/WebP",
  "Preparing",
  "Scanning pages",
  "document for search…",
  "documents for search…",
  "No documents yet. Upload a file to begin.",
  "Text document",
  "Mixed pages",
  "Scanned document",
  "Tables and layout",
  "Needs review",
  "No text found",
  "Inspect pages",
  "Reprocess",
  "Delete",
  "Page",
  "characters",
  "Language not detected",
  "Text extracted successfully.",
  "Ask across all documents",
  "Search answers across document languages",
  "Search for answers across document languages",
  "Across languages",
  "New conversation",
  "Delete conversation",
  "Opening conversation…",
  "This conversation has no messages.",
  "Couldn't open this conversation.",
  "Couldn't delete this conversation.",
  "Ask your documents.",
  "Upload a file from the library to start. Answers include pages you can open and review.",
  "Ask about your files in any language… (Enter to send, Shift+Enter for newline)",
  "Finding relevant pages and checking the answer…",
  "Abstained.",
  "Conflicting sources — not resolved, shown side by side",
  "Sources and answer checks",
  "page",
  "pages",
  "unsupported detail",
  "unsupported details",
  "removed",
  "Answer checks",
  "Open evidence",
  "Extracted text from this page",
  "loading…",
  "(no text stored for this page)",
  "Verifier report",
  "supported",
  "contradicted",
  "English",
  "on",
  "off",
  "Uploading",
  "Preparing",
  "Waiting",
  "pending",
  "Inspect pages",
  "Reprocess",
  "No text found",
  "Close",
  "Open full page render",
  "text source",
  "region highlight available",
  "page number",
  "Answer",
  "Enter to send",
  "Shift+Enter for a new line",
  "Request failed",
  "Upload failed",
  "Some files could not be added",
  "What is the total budget?",
  "Summarise the key figures",
  "Which scheme covers this?",
  "Vision pages",
  "Text pages",
  "Across languages on",
  "Across languages off",
  "Account language",
  "Wait before changing languages again",
];

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "as-IN", label: "অসমীয়া" },
  { code: "bn-IN", label: "বাংলা" },
  { code: "brx-IN", label: "बर'" },
  { code: "doi-IN", label: "डोगरी" },
  { code: "gu-IN", label: "ગુજરાતી" },
  { code: "hi-IN", label: "हिन्दी" },
  { code: "kn-IN", label: "ಕನ್ನಡ" },
  { code: "ks-IN", label: "کٲشُر" },
  { code: "kok-IN", label: "कोंकणी" },
  { code: "mai-IN", label: "मैथिली" },
  { code: "ml-IN", label: "മലയാളം" },
  { code: "mni-IN", label: "মৈতৈলোন্" },
  { code: "mr-IN", label: "मराठी" },
  { code: "ne-IN", label: "नेपाली" },
  { code: "od-IN", label: "ଓଡ଼ିଆ" },
  { code: "pa-IN", label: "ਪੰਜਾਬੀ" },
  { code: "sa-IN", label: "संस्कृतम्" },
  { code: "sat-IN", label: "ᱥᱟᱱᱛᱟᱲᱤ" },
  { code: "sd-IN", label: "سنڌي" },
  { code: "ta-IN", label: "தமிழ்" },
  { code: "te-IN", label: "తెలుగు" },
  { code: "ur-IN", label: "اردو" },
] as const;

type LanguageCode = (typeof LANGUAGES)[number]["code"];
type LanguageContextValue = {
  language: LanguageCode;
  setLanguage: (language: LanguageCode) => void;
  translating: boolean;
  t: (english: string) => string;
};

const STORAGE_KEY = "contextify-language-v1";
const context = createContext<LanguageContextValue | null>(null);
const PRIORITY_COPY = new Set([
  "Website language",
  "Your documents, ready to answer",
  "Document library",
  "Upload documents",
  "Ask across all documents",
  "Ask your documents.",
  "Welcome back",
  "Create your account",
  "Sign in",
]);
const CORE_COPY = [
  "Your documents, ready to answer",
  "Welcome back to Contextify.",
  "Your workspace",
  "Welcome back",
  "Create your account",
  "Sign in",
  "Create account",
  "Document library",
  "Upload documents",
  "Ask across all documents",
  "Ask your documents.",
];

async function translateBatch(language: LanguageCode, strings: string[]): Promise<Record<string, string>> {
  if (!strings.length) return {};
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("/api/ui/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, strings }),
      signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
    const translated = body.translations as string[];
    return Object.fromEntries(strings.map((text, index) => [text, translated[index] || text]));
  } finally {
    window.clearTimeout(timeout);
  }
}

function cachedTranslations(language: LanguageCode): Record<string, string> | null {
  if (language === "en") return {};
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}:${language}`);
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<LanguageCode>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.some((option) => option.code === stored) ? (stored as LanguageCode) : "en";
  });
  const [translations, setTranslations] = useState<Record<string, string>>(() => cachedTranslations(language) ?? {});
  const [translating, setTranslating] = useState(false);

  useEffect(() => {
    if (language === "en") {
      setTranslations({});
      setTranslating(false);
      return;
    }
    const cached = cachedTranslations(language) ?? {};
    setTranslations(cached);
    const missing = [...new Set(UI_COPY)].filter((text) => !cached[text] || cached[text] === text);
    if (!missing.length) {
      setTranslating(false);
      return;
    }
    let active = true;
    let cache = { ...cached };
    const mergeTranslations = (next: Record<string, string>) => {
      cache = { ...cache, ...next };
      if (!active) return;
      setTranslations(cache);
      localStorage.setItem(`${STORAGE_KEY}:${language}`, JSON.stringify(cache));
    };
    const showPriorityLoader = !CORE_COPY.every((text) => Boolean(cached[text]));
    const priority = showPriorityLoader ? missing.filter((text) => PRIORITY_COPY.has(text)) : [];
    const prioritySet = new Set(priority);
    const remaining = missing.filter((text) => !prioritySet.has(text));
    setTranslating(priority.length > 0);

    void (async () => {
      if (priority.length) {
        try {
          mergeTranslations(await translateBatch(language, priority));
        } catch {
          if (active) setTranslating(false);
          return;
        }
      }
      if (active) setTranslating(false);
      if (!remaining.length) return;
      try {
        mergeTranslations(await translateBatch(language, remaining));
      } catch {
        // Keep the immediately available partial catalogue if background translation is unavailable.
      }
    })();

    return () => {
      active = false;
    };
  }, [language]);

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      setLanguage: (next) => {
        localStorage.setItem(STORAGE_KEY, next);
        setLanguageState(next);
      },
      translating,
      t: (english) => translations[english] ?? english,
    }),
    [language, translating, translations],
  );

  return <context.Provider value={value}>{children}</context.Provider>;
}

export function useUiLanguage(): LanguageContextValue {
  const value = useContext(context);
  if (!value) throw new Error("LanguageProvider is missing.");
  return value;
}

export function LanguagePicker() {
  const { language, setLanguage, translating, t } = useUiLanguage();
  return (
    <label className="flex items-center gap-1.5 rounded-lg border border-[#b9945b] bg-[#fff9e9] px-2 py-1 font-semibold text-[#2f1b0b]">
      {translating ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Languages size={14} aria-hidden="true" />}
      <span className="sr-only">{t("Website language")}</span>
      <select
        aria-label={t("Website language")}
        title={t("Website language")}
        value={language}
        onChange={(event) => setLanguage(event.target.value as LanguageCode)}
        className="max-w-28 cursor-pointer bg-transparent text-xs font-semibold outline-none"
      >
        {LANGUAGES.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
      </select>
    </label>
  );
}