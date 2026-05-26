import type { DomainCreateResult, DomainListResult, MailboxCreateResult } from "./types";

export async function getDomains(): Promise<DomainListResult> {
	const res = await fetch("/api/domains");
	return (await res.json()) as DomainListResult;
}

export async function createDomain(hostname: string): Promise<{ ok: boolean; data: DomainCreateResult }> {
	const res = await fetch("/api/domains", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ hostname, enableRouting: true, enableSending: true }),
	});

	return {
		ok: res.ok,
		data: (await res.json()) as DomainCreateResult,
	};
}

export async function createMailbox(
	domainId: string,
	localPart: string,
): Promise<{ ok: boolean; data: MailboxCreateResult }> {
	const res = await fetch("/api/mailboxes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ domainId, localPart, displayName: localPart }),
	});

	return {
		ok: res.ok,
		data: (await res.json()) as MailboxCreateResult,
	};
}
