/** Shared types and helpers of the DNS helper adapters. */
import type { DomainRecord } from "./smtp2go";

export type DnsCreds = Record<string, string>;
export type DnsProviderInfo = {
	id: string;
	label: string;
	fields: { key: string; label: string; secret?: boolean }[];
	help: string;
	helpUrl: string;
};
export type DnsRecordResult = { record: string; type: string; name: string; status: "added" | "exists" | "failed"; error?: string };
export type DnsHelperResult = { provider: string; zone: string; results: DnsRecordResult[] };

export type Wanted = Pick<DomainRecord, "record" | "type" | "name" | "value" | "priority">;
export type Adapter = {
	info: DnsProviderInfo;
	/** Zone (domain) the host manages for `candidate`, or null when the account does not have it. */
	findZone(candidate: string, creds: DnsCreds): Promise<string | null>;
	/** Create one record; resolves "exists" when an identical one is already there. */
	create(zone: string, rec: Wanted, creds: DnsCreds): Promise<"added" | "exists">;
	/** Runs once after the records were sent (some hosts need a zone refresh). */
	finish?(zone: string, creds: DnsCreds): Promise<void>;
};

export class ProviderError extends Error {}
export const TIMEOUT_MS = 10_000;

export async function call(url: string, init: RequestInit = {}): Promise<{ status: number; body: any; text: string }> {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => {
		throw new ProviderError("Could not reach the DNS provider");
	});
	const text = await response.text().catch(() => "");
	let body: any = null;
	try { body = JSON.parse(text); } catch { /* not JSON (XML, empty) */ }
	return { status: response.status, body, text };
}

/** `mail.acme.co.uk` -> [mail.acme.co.uk, acme.co.uk, co.uk]: the zone is the first one the account owns. */
export function zoneCandidates(hostname: string): string[] {
	const labels = hostname.toLowerCase().split(".");
	return labels.slice(0, -1).map((_, i) => labels.slice(i).join(".")).filter((c) => c.includes("."));
}

/** Record name relative to its zone ("@" for the apex). */
export function relative(name: string, zone: string, apex: string): string {
	const n = name.toLowerCase().replace(/\.$/, "");
	if (n === zone) return apex;
	return n.endsWith(`.${zone}`) ? n.slice(0, -zone.length - 1) : n;
}

export const need = (creds: DnsCreds, key: string) => {
	const v = creds[key]?.trim();
	if (!v) throw new ProviderError("Fill in every field");
	return v;
};


/** Value for hosts that want a fully qualified target (trailing dot). */
export const fqdn = (value: string) => (value.endsWith(".") ? value : `${value}.`);
/** Basic-auth header value. */
export const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;
export const jsonHeaders = (extra: Record<string, string>) => ({ "Content-Type": "application/json", ...extra });
