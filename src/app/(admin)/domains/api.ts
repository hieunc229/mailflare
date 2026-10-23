import { defaultTranslator } from "@/lib/i18n/utils";
import { authFetch } from "@/lib/auth/client";

/** A rejected response, keeping the parsed body so callers can read fields beyond `error`. */
export class ApiError extends Error {
	constructor(message: string, readonly data: unknown) {
		super(message);
		this.name = "ApiError";
	}
}

export async function requestJson<T>(url: string, method: string, body?: unknown): Promise<T> {
	const response = await authFetch(url, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		cache: "no-store",
	});
	const data = (await response.json()) as T & { error?: string };
	if (!response.ok) throw new ApiError(data.error ?? defaultTranslator("domains.requestFailed"), data);
	return data;
}

export const postJson = <T,>(url: string, method: string, body: unknown) => requestJson<T>(url, method, body);

type SetupResponse = { error?: string; code?: string; records?: { content: string; priority: number }[] };

/** Whether a response is a 409 MX_CONFLICT the user agreed to resolve by replacing the listed MX records. */
export function confirmMxReplacement(response: Response, data: SetupResponse): boolean {
	if (response.status !== 409 || (data.code !== "MX_CONFLICT" && data.code !== "MX_RECORDS_CONFLICT")) return false;
	const list = (data.records ?? []).map((record) => `  ${record.priority} ${record.content}`).join("\n");
	const details = list ? `\n\n${list}` : "";
	return window.confirm(`${data.error}${details}\n\nReplace them? Mail will stop going to the current service.`);
}

export function isMxConflictError(error: unknown): boolean {
	if (!(error instanceof ApiError) || !error.data || typeof error.data !== "object") return false;
	const code = (error.data as { code?: unknown }).code;
	return code === "MX_CONFLICT" || code === "MX_RECORDS_CONFLICT";
}

/**
 * Runs a receiving provider's setup. Other MX records would shadow the new one,
 * so the server refuses (409) until the user agrees to replace them.
 * Returns false when the user declined.
 */
export async function runReceivingSetup(domainId: string, provider: "cloudflare" | "resend" | "ses"): Promise<boolean> {
	const call = async (replaceMx: boolean) => {
		const response = await authFetch(`/api/domains/${domainId}/receiving/${provider}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ replaceMx }),
		});
		return { response, data: (await response.json()) as SetupResponse };
	};
	let { response, data } = await call(false);
	if (response.status === 409 && data.code === "MX_CONFLICT") {
		if (!confirmMxReplacement(response, data)) return false;
		({ response, data } = await call(true));
	}
	if (!response.ok) throw new Error(data.error ?? defaultTranslator("domains.setupFailed"));
	return true;
}

export type CreateDomainInput = {
	hostname: string;
	enableRouting?: boolean;
	enableSending?: boolean;
	replaceMxRecords?: boolean;
	skipDns?: boolean;
	sendingProvider?: "none" | "cloudflare" | "resend" | "ses";
	receivingProvider?: "none" | "cloudflare" | "resend" | "ses";
};

export type DomainCreateResponse = SetupResponse & { domain?: unknown; [key: string]: unknown };

/**
 * Creates a domain. On a 409 MX conflict, confirms replacement with the user
 * and retries with replaceMxRecords set.
 */
export async function createDomain(input: CreateDomainInput): Promise<DomainCreateResponse> {
	const call = async (replaceMxRecords: boolean) => {
		const response = await authFetch("/api/domains", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(replaceMxRecords ? { ...input, replaceMxRecords: true } : input),
		});
		const data = (await response.json()) as DomainCreateResponse;
		return { response, data };
	};

	let { response, data } = await call(false);
	if (confirmMxReplacement(response, data)) {
		({ response, data } = await call(true));
	}
	if (!response.ok) throw new ApiError(data.error ?? defaultTranslator("mailboxes.failed"), data);
	return data;
}
