import type { ResendDomain, ResendReceivedEmail, ResendWebhook } from "@/lib/email/resend-api-types";

const RESEND_DEFAULT_BASE_URL = "https://api.resend.com";

type ResendEnv = { RESEND_BASE_URL?: string; RESEND_CUSTOM_MESSAGE_ID?: string };

/** Where Resend calls go and the key they carry. */
export type ResendClient = { apiKey: string; baseUrl: string };

/**
 * RESEND_BASE_URL points the Resend provider at a Resend-compatible API
 * instead of api.resend.com.
 */
export function resendBaseUrl(env: object): string {
	return ((env as ResendEnv).RESEND_BASE_URL?.trim() || RESEND_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function resendClient(env: object, apiKey: string): ResendClient {
	return { apiKey, baseUrl: resendBaseUrl(env) };
}

/**
 * Resend accepts a custom Message-ID header; some Resend-compatible services
 * refuse it. RESEND_CUSTOM_MESSAGE_ID=false stops sending it, and the sent
 * message's own Message-ID is read back instead (see fetchSentMessageId).
 */
export function resendSetsMessageId(env: object): boolean {
	return (env as ResendEnv).RESEND_CUSTOM_MESSAGE_ID?.trim().toLowerCase() !== "false";
}

// Until a send leaves the provider's queue its message_id can be a placeholder
// (one compatible service answers <id@unsent.…> while `last_event` is "queued").
const UNSENT_EVENTS = new Set(["queued", "scheduled"]);
const MESSAGE_ID_SHAPE = /^<[^<>\s]+@[^<>\s]+>$/;

export type SentMessageIdPolling = { attempts: number; delayMs: number; sleep: (ms: number) => Promise<void> };

const defaultPolling: SentMessageIdPolling = {
	attempts: 6,
	delayMs: 1000,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

async function readSentEmail(client: ResendClient, emailId: string): Promise<{ messageId: string | null; unsent: boolean } | null> {
	const response = await fetch(`${client.baseUrl}/emails/${encodeURIComponent(emailId)}`, {
		headers: { Authorization: `Bearer ${client.apiKey}` },
	}).catch(() => null);
	if (!response?.ok) return null;
	const body = (await response.json().catch(() => null)) as { message_id?: unknown; last_event?: unknown } | null;
	const value = typeof body?.message_id === "string" ? body.message_id.trim() : "";
	return { messageId: MESSAGE_ID_SHAPE.test(value) ? value : null, unsent: UNSENT_EVENTS.has(String(body?.last_event)) };
}

/**
 * The Message-ID the provider gave a sent email, read from `GET /emails/{id}`
 * once the email has left the queue. Resend reports none; some compatible
 * services do. Polls briefly (the ID arrives within seconds), else null.
 */
export async function fetchSentMessageId(
	client: ResendClient,
	emailId: string,
	polling: SentMessageIdPolling = defaultPolling,
): Promise<string | null> {
	for (let attempt = 1; attempt <= polling.attempts; attempt += 1) {
		const email = await readSentEmail(client, emailId);
		if (!email) return null;
		if (!email.unsent) return email.messageId;
		if (attempt < polling.attempts) await polling.sleep(polling.delayMs);
	}
	return null;
}

export class ResendRestrictedKeyError extends Error {
	constructor() {
		super("This Resend key can only send mail, so Mailflare cannot add or check domains. Add the domain in the Resend dashboard, or use a full-access key.");
	}
}

async function resendRequest<T>(client: ResendClient, path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${client.baseUrl}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${client.apiKey}`, "Content-Type": "application/json", ...init?.headers },
	});
	const body = (await response.json().catch(() => null)) as { message?: string; name?: string } | null;
	if (!response.ok) {
		// A send-only key cannot manage domains; say so instead of a bare 401.
		if (body?.name === "restricted_api_key") {
			throw new ResendRestrictedKeyError();
		}
		throw new Error(`Resend: ${body?.message ?? `request failed (${response.status})`}`);
	}
	return body as T;
}

export async function findResendDomain(client: ResendClient, hostname: string): Promise<ResendDomain | null> {
	const list = await resendRequest<{ data: ResendDomain[] }>(client, "/domains");
	const match = list.data.find((domain) => domain.name.toLowerCase() === hostname.toLowerCase());
	return match ? getResendDomain(client, match.id) : null;
}

export function getResendDomain(client: ResendClient, id: string): Promise<ResendDomain> {
	return resendRequest<ResendDomain>(client, `/domains/${encodeURIComponent(id)}`);
}

export type ResendCapabilities = { sending: boolean; receiving: boolean };

const toCapabilities = (capabilities: ResendCapabilities) => ({
	sending: capabilities.sending ? "enabled" : "disabled",
	receiving: capabilities.receiving ? "enabled" : "disabled",
});

export function createResendDomain(client: ResendClient, hostname: string, capabilities: ResendCapabilities = { sending: true, receiving: false }): Promise<ResendDomain> {
	return resendRequest<ResendDomain>(client, "/domains", { method: "POST", body: JSON.stringify({ name: hostname, capabilities: toCapabilities(capabilities) }) });
}

/** Turns a capability on without touching the other (omitted fields keep their value). */
export async function updateResendCapabilities(client: ResendClient, id: string, capabilities: Partial<ResendCapabilities>): Promise<void> {
	const body: Record<string, string> = {};
	if (capabilities.sending !== undefined) body.sending = capabilities.sending ? "enabled" : "disabled";
	if (capabilities.receiving !== undefined) body.receiving = capabilities.receiving ? "enabled" : "disabled";
	await resendRequest<unknown>(client, `/domains/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ capabilities: body }) });
}

export async function listResendWebhooks(client: ResendClient): Promise<ResendWebhook[]> {
	return (await resendRequest<{ data: ResendWebhook[] }>(client, "/webhooks")).data;
}

export function createResendWebhook(client: ResendClient, endpoint: string): Promise<{ id: string; signing_secret: string }> {
	return resendRequest(client, "/webhooks", { method: "POST", body: JSON.stringify({ endpoint, events: ["email.received"] }) });
}

export async function deleteResendWebhook(client: ResendClient, id: string): Promise<void> {
	await resendRequest<unknown>(client, `/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getReceivedEmail(client: ResendClient, id: string): Promise<ResendReceivedEmail> {
	return resendRequest<ResendReceivedEmail>(client, `/emails/receiving/${encodeURIComponent(id)}`);
}

export async function verifyResendDomain(client: ResendClient, id: string): Promise<void> {
	await resendRequest<unknown>(client, `/domains/${encodeURIComponent(id)}/verify`, { method: "POST" });
}

/**
 * A key is valid if Resend accepts it at all. Send-only keys are rejected by the
 * domains endpoint with `restricted_api_key`, which still means the key works.
 */
export async function checkResendKey(client: ResendClient): Promise<{ valid: boolean; canManageDomains: boolean }> {
	const response = await fetch(`${client.baseUrl}/domains`, { headers: { Authorization: `Bearer ${client.apiKey}` } });
	if (response.ok) return { valid: true, canManageDomains: true };
	const body = (await response.json().catch(() => null)) as { name?: string } | null;
	if (response.status === 401 && body?.name === "restricted_api_key") return { valid: true, canManageDomains: false };
	return { valid: false, canManageDomains: false };
}

export async function deleteResendDomain(client: ResendClient, id: string): Promise<void> {
	await resendRequest<unknown>(client, `/domains/${encodeURIComponent(id)}`, { method: "DELETE" });
}
