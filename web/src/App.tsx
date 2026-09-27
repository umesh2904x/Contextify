import { useEffect, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, BookOpenText, FileText, LockKeyhole, LogOut, MessagesSquare, Sparkles } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { authConfigured, hashPrivatePassword, LOCAL_ACCESS_SESSION_KEY, supabase } from "./auth";
import { LanguagePicker, useUiLanguage } from "./i18n";
import { Library } from "./Library";
import { Chat } from "./Chat";

function App() {
  const { t } = useUiLanguage();
  const [pending, setPending] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [localAccessSession, setLocalAccessSession] = useState(() => import.meta.env.DEV && sessionStorage.getItem(LOCAL_ACCESS_SESSION_KEY) === "active");
  const [checkingSession, setCheckingSession] = useState(Boolean(supabase));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [otp, setOtp] = useState("");
  const [awaitingOtp, setAwaitingOtp] = useState(false);
  const [privateFiles, setPrivateFiles] = useState(false);
  const [privatePassword, setPrivatePassword] = useState("");
  const [privateFilesEnabled, setPrivateFilesEnabled] = useState(() => localStorage.getItem("contextify-private-files") === "on");
  const [privatePasswordOpen, setPrivatePasswordOpen] = useState(false);
  const [privatePasswordInput, setPrivatePasswordInput] = useState("");
  const [privatePasswordError, setPrivatePasswordError] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!supabase) {
      setCheckingSession(false);
      return;
    }

    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not restore your session.");
    }).finally(() => {
      if (active) setCheckingSession(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setNotice("");
    if (mode === "signin" && import.meta.env.DEV && email.trim() === "2904" && password === "2904") {
      sessionStorage.setItem(LOCAL_ACCESS_SESSION_KEY, "active");
      setLocalAccessSession(true);
      return;
    }
    if (!supabase) {
      setError(import.meta.env.DEV && mode === "signin" ? "Account ID or password is incorrect." : "Account setup is not connected yet.");
      return;
    }
    setLoading(true);
    try {
      if (mode === "signup") {
        if (awaitingOtp) {
          const { data, error: authError } = await supabase.auth.verifyOtp({ email: email.trim(), token: otp.trim(), type: "signup" });
          if (authError) throw authError;
          if (data.session) setSession(data.session);
          else setNotice("OTP verified. Sign in to open your workspace.");
          setAwaitingOtp(false);
          return;
        }
        const { data, error: authError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: {
              first_name: firstName.trim(),
              last_name: lastName.trim(),
              private_files: privateFiles,
              private_password_hash: privateFiles ? await hashPrivatePassword(privatePassword) : null,
            },
          },
        });
        if (authError) throw authError;
        if (data.session) setSession(data.session);
        else {
          setAwaitingOtp(true);
          setNotice("Enter the OTP sent to your email to verify your account.");
        }
      } else {
        const { data, error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (authError) throw authError;
        setSession(data.session);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const resendOtp = async () => {
    if (!supabase || !email.trim()) return;
    setError("");
    setNotice("");
    setLoading(true);
    try {
      const { error: authError } = await supabase.auth.resend({ type: "signup", email: email.trim() });
      if (authError) throw authError;
      setNotice("A new OTP has been sent to your email.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not resend the OTP.");
    } finally {
      setLoading(false);
    }
  };

  const confirmPrivateToggle = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (privatePasswordInput !== "2904") {
      setPrivatePasswordError(t("Incorrect private files password."));
      return;
    }
    const next = !privateFilesEnabled;
    setPrivateFilesEnabled(next);
    localStorage.setItem("contextify-private-files", next ? "on" : "off");
    setPrivatePasswordInput("");
    setPrivatePasswordError("");
    setPrivatePasswordOpen(false);
  };

  const signOut = async () => {
    if (localAccessSession) {
      sessionStorage.removeItem(LOCAL_ACCESS_SESSION_KEY);
      setLocalAccessSession(false);
      return;
    }
    if (!supabase) return;
    setLoading(true);
    const { error: authError } = await supabase.auth.signOut();
    if (authError) setError(authError.message);
    else setSession(null);
    setLoading(false);
  };

  if (checkingSession) {
    return <div className="flex h-screen items-center justify-center text-sm text-[#80603a]">{t("Opening your workspace…")}</div>;
  }

  if (!session && !localAccessSession) {
    return (
      <main className="welcome-stage flex min-h-screen items-center justify-center px-4 py-6 sm:px-8 sm:py-10">
        <motion.section
          initial={{ opacity: 0, y: 18, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.55, ease: [0.2, 0.75, 0.25, 1] }}
          className="welcome-frame grid w-full max-w-6xl overflow-hidden rounded-[24px] border border-[#d9bd85] bg-[#fffdf6] shadow-[0_32px_90px_rgba(92,57,19,0.18)] md:grid-cols-[1.05fr_0.95fr]"
        >
          <section className="welcome-panel relative flex min-h-[300px] flex-col overflow-hidden bg-[#efb54e] p-6 text-[#382512] sm:min-h-[640px] sm:p-10">
            <div className="welcome-pattern absolute inset-0" aria-hidden="true" />
            <div className="welcome-beam absolute inset-y-0 left-0 w-1/3" aria-hidden="true" />
            <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 }} className="relative z-10 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/60 bg-white/45 text-[#54320d] shadow-[0_5px_15px_rgba(91,58,18,0.12)]">
                <BookOpenText size={22} />
              </div>
              <div>
                <div className="text-lg font-bold text-[#382512]">Contextify</div>
                <div className="text-xs font-medium text-[#493014]">{t("Your documents, ready to answer")}</div>
              </div>
            </motion.div>

            <AnimatePresence mode="wait">
              <motion.div
                key={mode}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.28 }}
                className="relative z-10 mt-9 sm:mt-16"
              >
                <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#8e5d1e]/25 bg-white/35 px-3 py-1.5 text-xs font-semibold text-[#543512]">
                  <Sparkles size={14} /> {t("A clearer way to work with your files")}
                </div>
                <h1 className="max-w-lg text-3xl font-bold leading-tight text-[#382512] sm:text-5xl">
                  {t(mode === "signin" ? "Welcome back to Contextify." : "Make room for better answers.")}
                </h1>
                <p className="mt-4 max-w-md text-sm leading-6 text-[#472e17] sm:text-base sm:leading-7">
                  {t("Keep important documents close, ask questions in your own words, and follow every answer back to its source.")}
                </p>
              </motion.div>
            </AnimatePresence>

            <div className="relative z-10 mt-8 grid gap-3 border-t border-[#82551c]/30 pt-5 text-sm font-semibold text-[#41290f] sm:mt-auto sm:grid-cols-2 sm:pt-7">
              <div className="flex items-center gap-2.5"><FileText size={17} className="text-[#7b4915]" /> {t("Your files, in one place")}</div>
              <div className="flex items-center gap-2.5"><MessagesSquare size={17} className="text-[#7b4915]" /> {t("Answers with source pages")}</div>
            </div>
          </section>

          <section className="flex items-center bg-[#fffdf6] px-6 py-8 sm:px-10 sm:py-12">
            <div className="mx-auto w-full max-w-sm">
              <div className="mb-4 flex items-center justify-between gap-2"><p className="text-xs font-bold uppercase text-[#86531d]">{t("Your workspace")}</p><LanguagePicker /></div>
              <h2 className="mt-2 text-2xl font-bold text-[#342313] sm:text-3xl">{t(mode === "signin" ? "Welcome back" : "Create your account")}</h2>
              <p className="mt-2 text-sm leading-6 text-[#49371f]">
                {t(mode === "signin" ? "Sign in to pick up where you left off." : "Set up your account and start with your documents.")}
              </p>

              <div role="tablist" aria-label="Account access" className="mt-7 grid grid-cols-2 gap-1 rounded-xl border border-[#ddc99f] bg-[#f6eddc] p-1">
                {(["signin", "signup"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={mode === tab}
                    onClick={() => { setMode(tab); setAwaitingOtp(false); setOtp(""); setError(""); setNotice(""); }}
                    className={`rounded-lg px-3 py-2.5 text-sm font-semibold transition ${mode === tab ? "bg-white text-[#432c18] shadow-[0_2px_8px_rgba(78,50,17,0.14)]" : "text-[#584127] hover:text-[#342313]"}`}
                  >
                    {t(tab === "signin" ? "Sign in" : "Create account")}
                  </button>
                ))}
              </div>

              {!authConfigured && (
                <div role="status" className="mt-5 rounded-lg border border-[#d6ae5f] bg-[#fff2cd] px-3.5 py-3 text-sm leading-5 text-[#573812]">
                  {import.meta.env.DEV && mode === "signin"
                    ? t("Account ID: 2904 · Password: 2904. Real accounts need login setup.")
                    : t("Account creation needs login setup. Add your account settings to the local environment file and restart the app.")}
                </div>
              )}

              <form className="mt-6 space-y-4" onSubmit={(event) => void submitAuth(event)}>
                {mode === "signup" && !awaitingOtp && (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="signup-first-name" className="mb-1.5 block text-sm font-semibold text-[#392817]">{t("First name")}</label>
                      <input id="signup-first-name" type="text" autoComplete="given-name" required value={firstName} onChange={(event) => setFirstName(event.target.value)} className="w-full rounded-lg border border-[#c5ad81] bg-white px-3 py-2.5 text-sm text-[#342313] outline-none focus:border-[#a8671f] focus:ring-2 focus:ring-[#eab752]/35" placeholder={t("Your first name")} />
                    </div>
                    <div>
                      <label htmlFor="signup-last-name" className="mb-1.5 block text-sm font-semibold text-[#392817]">{t("Surname")}</label>
                      <input id="signup-last-name" type="text" autoComplete="family-name" required value={lastName} onChange={(event) => setLastName(event.target.value)} className="w-full rounded-lg border border-[#c5ad81] bg-white px-3 py-2.5 text-sm text-[#342313] outline-none focus:border-[#a8671f] focus:ring-2 focus:ring-[#eab752]/35" placeholder={t("Your surname")} />
                    </div>
                  </div>
                )}
                {mode === "signup" && !awaitingOtp && (
                  <div className="rounded-lg border border-[#ddc99f] bg-[#fff8e7] p-3">
                    <label className="flex items-start gap-2 text-sm font-semibold text-[#392817]">
                      <input type="checkbox" checked={privateFiles} onChange={(event) => setPrivateFiles(event.target.checked)} className="mt-0.5 accent-[#a8671f]" />
                      <span>{t("Enable private company files")}</span>
                    </label>
                    <p className="mt-1 pl-6 text-xs leading-5 text-[#604c33]">{t("Only the manager with the private password can open these files.")}</p>
                    {privateFiles && (
                      <div className="mt-3">
                        <label htmlFor="private-files-password" className="mb-1.5 block text-sm font-semibold text-[#392817]">{t("Private files password")}</label>
                        <input id="private-files-password" type="password" autoComplete="new-password" required minLength={8} value={privatePassword} onChange={(event) => setPrivatePassword(event.target.value)} className="w-full rounded-lg border border-[#c5ad81] bg-white px-3 py-2.5 text-sm text-[#342313] outline-none focus:border-[#a8671f] focus:ring-2 focus:ring-[#eab752]/35" placeholder={t("At least 8 characters")} />
                      </div>
                    )}
                  </div>
                )}
                <div>
                  <label htmlFor="login-email" className="mb-1.5 block text-sm font-semibold text-[#392817]">{t(mode === "signin" && import.meta.env.DEV ? "Email or account ID" : "Email")}</label>
                  <input
                    id="login-email"
                    type={mode === "signin" && import.meta.env.DEV ? "text" : "email"}
                    autoComplete={mode === "signin" && import.meta.env.DEV ? "username" : "email"}
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="w-full rounded-lg border border-[#c5ad81] bg-white px-3 py-2.5 text-sm text-[#342313] placeholder:text-[#706047] outline-none focus:border-[#a8671f] focus:ring-2 focus:ring-[#eab752]/35"
                    placeholder={t(mode === "signin" && import.meta.env.DEV ? "you@example.com or 2904" : "you@example.com")}
                  />
                </div>
                <div className={mode === "signup" && awaitingOtp ? "hidden" : ""}>
                  <label htmlFor="login-password" className="mb-1.5 block text-sm font-semibold text-[#392817]">{t("Password")}</label>
                  <input
                    id="login-password"
                    type="password"
                    autoComplete={mode === "signin" ? "current-password" : "new-password"}
                    required={!awaitingOtp}
                    minLength={!awaitingOtp && (mode === "signup" || !import.meta.env.DEV) ? 6 : undefined}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="w-full rounded-lg border border-[#c5ad81] bg-white px-3 py-2.5 text-sm text-[#342313] placeholder:text-[#706047] outline-none focus:border-[#a8671f] focus:ring-2 focus:ring-[#eab752]/35"
                    placeholder={t(mode === "signin" && import.meta.env.DEV ? "Password or 2904" : "At least 6 characters")}
                  />
                </div>

                {mode === "signup" && awaitingOtp && (
                  <div>
                    <label htmlFor="signup-otp" className="mb-1.5 block text-sm font-semibold text-[#392817]">{t("Email OTP")}</label>
                    <input id="signup-otp" type="text" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))} className="w-full rounded-lg border border-[#c5ad81] bg-white px-3 py-2.5 text-center text-lg tracking-[0.35em] text-[#342313] outline-none focus:border-[#a8671f] focus:ring-2 focus:ring-[#eab752]/35" placeholder="123456" />
                    <button type="button" onClick={() => void resendOtp()} disabled={loading} className="mt-2 text-xs font-semibold text-[#a35d1c] hover:underline disabled:opacity-50">{t("Resend OTP")}</button>
                  </div>
                )}

                {error && <p role="alert" className="rounded-lg border border-[#d9a896] bg-[#fff0e8] px-3 py-2 text-sm text-[#7d321d]">{t(error)}</p>}
                {notice && <p role="status" className="rounded-lg border border-[#d6bf82] bg-[#fff7df] px-3 py-2 text-sm text-[#604618]">{t(notice)}</p>}

                <button
                  type="submit"
                  disabled={loading || (!authConfigured && !(import.meta.env.DEV && mode === "signin"))}
                  className="shine-button flex w-full items-center justify-center gap-2 rounded-lg bg-[#dc872d] px-4 py-3 text-sm font-bold text-[#2f1b0b] shadow-[0_8px_18px_rgba(146,86,25,0.2)] transition hover:bg-[#cf7623] disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {loading ? t("Please wait…") : t(mode === "signin" ? "Sign in to Contextify" : awaitingOtp ? "Verify OTP" : "Create my account")}
                  <ArrowRight size={16} />
                </button>
              </form>

              {mode === "signup" && <p className="mt-4 text-xs leading-5 text-[#604c33]">{t("A confirmation email may be required before your first sign-in.")}</p>}
            </div>
          </section>
        </motion.section>
      </main>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-amber-900/10 bg-[#fff9ec]/90 px-5 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#eea83d] text-[#4b2a0d] shadow-[0_5px_14px_rgba(193,117,28,0.2)]">
            <BookOpenText size={18} />
          </div>
          <div className="leading-tight">
            <div className="text-base font-bold text-[#432c18]">Contextify</div>
            <div className="text-[11px] text-[#947044]">{t("Your documents, ready to answer")}</div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <LanguagePicker />
          <button
            type="button"
            onClick={() => { setPrivatePasswordError(""); setPrivatePasswordOpen(true); }}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${privateFilesEnabled ? "border-[#b6782d] bg-[#fff0c9] text-[#5a3513]" : "border-[#e2d0ab] text-[#6d4b27] hover:bg-[#fff1d2]"}`}
            title={t("Private files")}
          >
            <LockKeyhole size={14} /> {t("Private files")} {privateFilesEnabled ? "ON" : "OFF"}
          </button>
          <span className="hidden text-xs font-semibold text-[#432c18] sm:block">{session?.user.email ?? "Account 2904"}</span>
          <button onClick={() => void signOut()} disabled={loading} className="flex items-center gap-1.5 rounded-lg border border-[#b9945b] px-2.5 py-1.5 text-xs font-bold text-[#2f1b0b] hover:bg-[#fff1d2] disabled:opacity-50" title={t("Sign out")}>
            <LogOut size={14} /> {t("Sign out")}
          </button>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[340px_1fr]">
        <aside className="panel min-h-0 border-b border-amber-900/10 md:border-b-0 md:border-r">
          <Library onAsk={(q) => setPending(q)} showPrivateFiles={privateFilesEnabled} />
        </aside>
        <section className="min-h-0 overflow-hidden">
          <Chat key={pending ?? "chat"} autoAsk={pending} onAsked={() => setPending(null)} />
        </section>
      </main>

      {privatePasswordOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#3a2415]/45 p-4">
          <form onSubmit={confirmPrivateToggle} className="w-full max-w-sm rounded-xl border border-[#d9bd85] bg-[#fffdf6] p-5 shadow-[0_24px_70px_rgba(70,40,12,0.25)]">
            <h2 className="text-lg font-bold text-[#342313]">{t("Manager password required")}</h2>
            <p className="mt-1 text-sm leading-5 text-[#604c33]">{t("Enter the password to change private file visibility.")}</p>
            <label htmlFor="private-toggle-password" className="mt-4 mb-1.5 block text-sm font-semibold text-[#392817]">{t("Private files password")}</label>
            <input id="private-toggle-password" autoFocus type="password" value={privatePasswordInput} onChange={(event) => setPrivatePasswordInput(event.target.value)} className="w-full rounded-lg border border-[#c5ad81] bg-white px-3 py-2.5 text-sm text-[#342313] outline-none focus:border-[#a8671f] focus:ring-2 focus:ring-[#eab752]/35" />
            {privatePasswordError && <p role="alert" className="mt-2 text-sm text-[#9a3822]">{privatePasswordError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => { setPrivatePasswordOpen(false); setPrivatePasswordInput(""); }} className="rounded-lg border border-[#d8c69e] px-3 py-2 text-sm font-semibold text-[#604c33]">{t("Cancel")}</button>
              <button type="submit" className="rounded-lg bg-[#dc872d] px-3 py-2 text-sm font-bold text-[#2f1b0b]">{t("Confirm")}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default App;
