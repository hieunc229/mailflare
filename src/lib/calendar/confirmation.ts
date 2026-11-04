import { getServerSecret } from "@/lib/security/server-secret";
import type { CalendarToolName } from "./tool-types";

/** Calendar tools that change or remove existing events; an assistant may only propose these. */
export const CONFIRMED_CALENDAR_TOOLS: ReadonlySet<CalendarToolName> = new Set(["update_events", "delete_events"]);

const LIFETIME_MS = 15 * 60_000;

export type CalendarConfirmation = { userId: string; name: CalendarToolName; input: unknown; expiresAt: number };

const encode = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decode = (value: string) => new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0)));

async function mac(env: CloudflareEnv, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`calendar-confirmation\n${await getServerSecret(env)}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return encode(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)))));
}

/** A token the signed-in user opens in the app to approve exactly this change; the model cannot redeem it. */
export async function createCalendarConfirmation(env: CloudflareEnv, userId: string, name: CalendarToolName, input: unknown, now = Date.now()): Promise<string> {
	const payload = encode(JSON.stringify({ userId, name, input, expiresAt: now + LIFETIME_MS } satisfies CalendarConfirmation));
	return `${payload}.${await mac(env, payload)}`;
}

export async function readCalendarConfirmation(env: CloudflareEnv, token: string, userId: string, now = Date.now()): Promise<CalendarConfirmation | null> {
	const [payload, signature] = token.split(".");
	if (!payload || !signature) return null;
	const expected = await mac(env, payload);
	if (expected.length !== signature.length) return null;
	let diff = 0;
	for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
	if (diff !== 0) return null;
	try {
		const parsed = JSON.parse(decode(payload)) as CalendarConfirmation;
		if (parsed.userId !== userId || parsed.expiresAt < now || !CONFIRMED_CALENDAR_TOOLS.has(parsed.name)) return null;
		return parsed;
	} catch {
		return null;
	}
}
