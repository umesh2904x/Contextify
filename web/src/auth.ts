import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const LOCAL_ACCESS_SESSION_KEY = "contextify-local-access-session";
export const LOCAL_ACCESS_BEARER = "contextify-local-access-session";
export const authConfigured = Boolean(url && anonKey && url.startsWith("https://"));
export const supabase = authConfigured ? createClient(url!, anonKey!) : null;

export function getLocalAccessBearer(): string | null {
	return import.meta.env.DEV && sessionStorage.getItem(LOCAL_ACCESS_SESSION_KEY) === "active" ? LOCAL_ACCESS_BEARER : null;
}

export async function hashPrivatePassword(password: string): Promise<string> {
	const bytes = new TextEncoder().encode(password);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}