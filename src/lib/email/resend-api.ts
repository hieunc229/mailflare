import { getEnv } from "@/lib/cloudflare";
import type { ResendDomain, ResendReceivedEmail, ResendWebhook } from "@/lib/email/resend-api-types";

const RESEND_DEFAULT_BASE_URL = "https://api.resend.com";

/**
 * RESEND_BASE_URL points the Resend provider at a Resend-compatible API
 * (for example MillionSend) instead of api.resend.com.
 */
export function getResendBaseUrl(): string {
	const fromEnv = (getEnv() as { RESEND_BASE_URL?: string }).RESEND_BASE_URL?.trim();
	return (fromEnv || RESEND_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export class ResendRestrictedKeyError extends Error {
	constructor() {
		super("This Resend key can only send mail, so Mailflare cannot add or check domains. Add the domain in the Resend dashboard, or use a full-access key.");
	}
}

async function resendRequest<T>(apiKey: string, path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${getResendBaseUrl()}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...init?.headers },
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

export async function findResendDomain(apiKey: string, hostname: string): Promise<ResendDomain | null> {
	const list = await resendRequest<{ data: ResendDomain[] }>(apiKey, "/domains");
	const match = list.data.find((domain) => domain.name.toLowerCase() === hostname.toLowerCase());
	return match ? getResendDomain(apiKey, match.id) : null;
}

export function getResendDomain(apiKey: string, id: string): Promise<ResendDomain> {
	return resendRequest<ResendDomain>(apiKey, `/domains/${encodeURIComponent(id)}`);
}

export type ResendCapabilities = { sending: boolean; receiving: boolean };

const toCapabilities = (capabilities: ResendCapabilities) => ({
	sending: capabilities.sending ? "enabled" : "disabled",
	receiving: capabilities.receiving ? "enabled" : "disabled",
});

export function createResendDomain(apiKey: string, hostname: string, capabilities: ResendCapabilities = { sending: true, receiving: false }): Promise<ResendDomain> {
	return resendRequest<ResendDomain>(apiKey, "/domains", { method: "POST", body: JSON.stringify({ name: hostname, capabilities: toCapabilities(capabilities) }) });
}

/** Turns a capability on without touching the other (omitted fields keep their value). */
export async function updateResendCapabilities(apiKey: string, id: string, capabilities: Partial<ResendCapabilities>): Promise<void> {
	const body: Record<string, string> = {};
	if (capabilities.sending !== undefined) body.sending = capabilities.sending ? "enabled" : "disabled";
	if (capabilities.receiving !== undefined) body.receiving = capabilities.receiving ? "enabled" : "disabled";
	await resendRequest<unknown>(apiKey, `/domains/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ capabilities: body }) });
}

export async function listResendWebhooks(apiKey: string): Promise<ResendWebhook[]> {
	return (await resendRequest<{ data: ResendWebhook[] }>(apiKey, "/webhooks")).data;
}

export function createResendWebhook(apiKey: string, endpoint: string): Promise<{ id: string; signing_secret: string }> {
	return resendRequest(apiKey, "/webhooks", { method: "POST", body: JSON.stringify({ endpoint, events: ["email.received"] }) });
}

export async function deleteResendWebhook(apiKey: string, id: string): Promise<void> {
	await resendRequest<unknown>(apiKey, `/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getReceivedEmail(apiKey: string, id: string): Promise<ResendReceivedEmail> {
	return resendRequest<ResendReceivedEmail>(apiKey, `/emails/receiving/${encodeURIComponent(id)}`);
}

export async function verifyResendDomain(apiKey: string, id: string): Promise<void> {
	await resendRequest<unknown>(apiKey, `/domains/${encodeURIComponent(id)}/verify`, { method: "POST" });
}

/**
 * A key is valid if Resend accepts it at all. Send-only keys are rejected by the
 * domains endpoint with `restricted_api_key`, which still means the key works.
 */
export async function checkResendKey(apiKey: string): Promise<{ valid: boolean; canManageDomains: boolean }> {
	const response = await fetch(`${getResendBaseUrl()}/domains`, { headers: { Authorization: `Bearer ${apiKey}` } });
	if (response.ok) return { valid: true, canManageDomains: true };
	const body = (await response.json().catch(() => null)) as { name?: string } | null;
	if (response.status === 401 && body?.name === "restricted_api_key") return { valid: true, canManageDomains: false };
	return { valid: false, canManageDomains: false };
}

export async function deleteResendDomain(apiKey: string, id: string): Promise<void> {
	await resendRequest<unknown>(apiKey, `/domains/${encodeURIComponent(id)}`, { method: "DELETE" });
}
