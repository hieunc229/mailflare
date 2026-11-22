import type { OutlookApp, OutlookGrant, OutlookPending } from "./outlook-types";

/** Office 365 Exchange Online delegated scope. Basic auth on this endpoint is disabled. */
export const OUTLOOK_IMAP_SCOPE = "https://outlook.office365.com/IMAP.AccessAsUser.All";

export const OUTLOOK_SCOPES = ["openid", "email", "offline_access", OUTLOOK_IMAP_SCOPE].join(" ");

export const OUTLOOK_IMAP_HOST = "outlook.office365.com";
export const OUTLOOK_IMAP_PORT = 993;

const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = /^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function isMicrosoftClientId(value: string): boolean {
	return CLIENT_ID.test(value);
}

export function isMicrosoftTenant(value: string): boolean {
	return TENANT.test(value);
}

/** `common` covers work and personal accounts. Anything else falls back to that. */
export function normalizeMicrosoftTenant(value: string | null | undefined): string {
	const tenant = value?.trim() ?? "";
	return isMicrosoftTenant(tenant) ? tenant : "common";
}

export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** Standard base64, which is what SASL XOAUTH2 puts on the AUTHENTICATE line. */
export function xoauth2InitialResponse(username: string, accessToken: string): string {
	const bytes = new TextEncoder().encode(`user=${username}\u0001auth=Bearer ${accessToken}\u0001\u0001`);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function createPkceVerifier(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

/** S256 code challenge (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64UrlEncode(new Uint8Array(digest));
}

export function createOAuthState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

export function outlookAuthorizeUrl(input: {
	tenant: string;
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
}): string {
	const url = new URL(`https://login.microsoftonline.com/${input.tenant}/oauth2/v2.0/authorize`);
	url.searchParams.set("client_id", input.clientId);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", input.redirectUri);
	url.searchParams.set("response_mode", "query");
	url.searchParams.set("scope", OUTLOOK_SCOPES);
	url.searchParams.set("state", input.state);
	url.searchParams.set("code_challenge", input.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("prompt", "select_account");
	return url.toString();
}

export function outlookTokenUrl(tenant: string): string {
	return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

export function outlookRedirectUri(origin: string): string {
	return `${origin.replace(/\/$/, "")}/api/import/outlook/callback`;
}

/** Mailbox address carried by the id_token Microsoft returns with the openid/email scopes. */
export function emailFromIdToken(idToken: string): string | null {
	const part = idToken.split(".")[1];
	if (!part) return null;
	try {
		const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as {
			email?: unknown;
			preferred_username?: unknown;
			upn?: unknown;
		};
		for (const value of [payload.email, payload.preferred_username, payload.upn]) {
			if (typeof value === "string" && value.includes("@")) return value.trim();
		}
		return null;
	} catch {
		return null;
	}
}

export type MicrosoftTokenErrorBody = { error?: string; error_description?: string };

/** A short message for the import page. Microsoft's text never includes the tokens. */
export function microsoftTokenError(body: MicrosoftTokenErrorBody): string {
	const description = body.error_description?.split("\r")[0]?.split("\n")[0]?.trim() ?? "";
	if (body.error === "invalid_grant" || /AADSTS70008|AADSTS50173|AADSTS700082/.test(description)) {
		return "Microsoft sign-in expired; connect Outlook again";
	}
	if (/AADSTS65001|consent/i.test(description)) {
		return "Microsoft has not granted IMAP access. Add the delegated permission Office 365 Exchange Online → IMAP.AccessAsUser.All and grant consent.";
	}
	if (/AADSTS7000215|AADSTS7000218|client_secret|invalid_client/i.test(`${body.error ?? ""} ${description}`)) {
		return "Microsoft rejected the app credentials. A Web platform needs MICROSOFT_CLIENT_SECRET; a public client leaves the secret empty and registers the redirect URI under Mobile and desktop applications.";
	}
	if (description) return description.slice(0, 300);
	return "Microsoft sign-in failed";
}

const COOKIE_LIMIT = 3500;

export function encodeOutlookCookie(value: unknown): string {
	const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
	if (encoded.length > COOKIE_LIMIT) throw new Error("Microsoft sign-in could not be stored in the browser");
	return encoded;
}

export function decodeOutlookCookie(value: string): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
	} catch {
		return null;
	}
}

function readApp(value: Partial<OutlookApp>): OutlookApp | null {
	const clientId = value.clientId?.trim() ?? "";
	const tenant = value.tenant?.trim() ?? "";
	if (!isMicrosoftClientId(clientId) || !isMicrosoftTenant(tenant)) return null;
	if (value.clientSecret != null && typeof value.clientSecret !== "string") return null;
	const clientSecret = value.clientSecret?.trim() || null;
	if (clientSecret && clientSecret.length > 512) return null;
	return { clientId, clientSecret, tenant };
}

export function parseOutlookPending(value: unknown): OutlookPending | null {
	if (!value || typeof value !== "object") return null;
	const row = value as Partial<OutlookPending>;
	const app = readApp(row);
	if (!app || !row.state || !row.verifier || !row.userId) return null;
	if (row.state.length > 128 || row.verifier.length < 43 || row.verifier.length > 128) return null;
	return { ...app, state: row.state, verifier: row.verifier, userId: row.userId };
}

export function parseOutlookGrant(value: unknown): OutlookGrant | null {
	if (!value || typeof value !== "object") return null;
	const row = value as Partial<OutlookGrant>;
	const app = readApp(row);
	if (!app || !row.refreshToken || !row.username || !row.userId) return null;
	if (typeof row.refreshToken !== "string" || row.refreshToken.length > 8000) return null;
	if (typeof row.username !== "string" || !row.username.includes("@") || row.username.length > 320) return null;
	if (typeof row.userId !== "string" || row.userId.length > 80) return null;
	return { ...app, refreshToken: row.refreshToken, username: row.username.trim(), userId: row.userId };
}

export function parseOutlookAppInput(input: { clientId?: unknown; clientSecret?: unknown; tenant?: unknown }): OutlookApp {
	const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
	if (!isMicrosoftClientId(clientId)) throw new Error("Enter the application (client) ID from the Microsoft Entra app registration");
	const tenant = typeof input.tenant === "string" ? input.tenant.trim() : "";
	if (tenant && !isMicrosoftTenant(tenant)) throw new Error("Account type is invalid");
	const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
	if (clientSecret.length > 512) throw new Error("Client secret is too long");
	return { clientId, clientSecret: clientSecret || null, tenant: normalizeMicrosoftTenant(tenant) };
}

export function readMicrosoftOAuthConfig(env: {
	MICROSOFT_CLIENT_ID?: string;
	MICROSOFT_CLIENT_SECRET?: string;
	MICROSOFT_TENANT?: string;
}): OutlookApp | null {
	const clientId = env.MICROSOFT_CLIENT_ID?.trim() ?? "";
	if (!isMicrosoftClientId(clientId)) return null;
	const tenant = normalizeMicrosoftTenant(env.MICROSOFT_TENANT);
	if (env.MICROSOFT_TENANT?.trim() && !isMicrosoftTenant(env.MICROSOFT_TENANT.trim())) return null;
	const clientSecret = env.MICROSOFT_CLIENT_SECRET?.trim() || null;
	return { clientId, clientSecret, tenant };
}
