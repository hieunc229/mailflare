import { readResponseJson } from "@/lib/http/response";
import { authFetch } from "@/lib/auth/client";
import type {
	DomainCreateResult,
	DomainListResult,
	DomainPreflightResponse,
	MailboxCreateResult,
} from "./types";

export async function getDomains(): Promise<DomainListResult> {
	const res = await authFetch("/api/domains");
	return (await readResponseJson(res)) as DomainListResult;
}

export async function checkDomain(hostname: string): Promise<DomainPreflightResponse> {
	const res = await authFetch("/api/domains/check", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ hostname }),
	});
	const data = (await readResponseJson(res)) as Omit<DomainPreflightResponse, "ok">;
	return { ok: res.ok, ...data };
}

export async function createDomain(
	hostname: string,
	enableSending: boolean,
	replaceMxRecords = false,
	skipDns = false,
): Promise<{ ok: boolean; data: DomainCreateResult }> {
	const res = await authFetch("/api/domains", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ hostname, enableRouting: true, enableSending, replaceMxRecords, skipDns }),
	});

	return {
		ok: res.ok,
		data: (await readResponseJson(res)) as DomainCreateResult,
	};
}

export async function createMailbox(
	domainId: string,
	localPart: string,
	displayName: string,
): Promise<{ ok: boolean; data: MailboxCreateResult }> {
	const res = await authFetch("/api/mailboxes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ domainId, localPart, displayName }),
	});

	return {
		ok: res.ok,
		data: (await readResponseJson(res)) as MailboxCreateResult,
	};
}
