import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import type { DomainRow } from "@/lib/domains/types";
import { CLOUD_PROXY, getCloudBinding, getPlatformSmtp2goKey } from "./platform";

/**
 * Hosted workspaces send through the platform's SMTP2GO account (https://developers.smtp2go.com). SMTP2GO has no
 * receiving: inbound mail arrives through Cloudflare Email Routing (see worker.tenant.ts). A workspace admin only
 * publishes the DNS records SMTP2GO lists for each sender domain; there are no provider choices.
 */
const API = "https://api.smtp2go.com/v3";

export async function getSmtp2goApiKey(env: CloudflareEnv): Promise<string> {
	const key = await getPlatformSmtp2goKey(env);
	if (!key) throw new Error("Email delivery is not set up on this platform yet. Please contact support.");
	return key;
}

/** Every SMTP2GO endpoint is a JSON POST. In production it goes through the cloud app (which adds the key) or, locally, direct. */
export function smtp2goFetch(apiKey: string, path: string, body: Record<string, unknown>): Promise<Response> {
	const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
	if (apiKey === CLOUD_PROXY) {
		const cloud = getCloudBinding();
		if (!cloud) throw new Error("Email delivery is not set up on this platform yet. Please contact support.");
		return cloud.fetch(`https://smtp2go.internal/api/internal/smtp2go${path}`, init);
	}
	return fetch(`${API}${path}`, { ...init, headers: { ...init.headers, "X-Smtp2go-Api-Key": apiKey } });
}

type Smtp2goResult<T> = { request_id?: string; data?: T & { error?: string; error_code?: string } };

export async function smtp2goRequest<T>(apiKey: string, path: string, body: Record<string, unknown>): Promise<T> {
	const response = await smtp2goFetch(apiKey, path, body);
	const json = (await response.json().catch(() => null)) as Smtp2goResult<T> | { message?: string } | null;
	const data = (json as Smtp2goResult<T> | null)?.data;
	if (!response.ok || data?.error) {
		const message = data?.error ?? (json as { message?: string } | null)?.message ?? `request failed (${response.status})`;
		throw new Error(`Mail delivery: ${message}`);
	}
	return (data ?? {}) as T;
}

type Smtp2goDomainEntry = {
	domain: {
		fulldomain: string;
		dkim_selector: string; dkim_value: string; dkim_verified: boolean;
		rpath_selector: string; rpath_value: string; rpath_verified: boolean;
	};
	trackers?: { fulldomain: string; cname_value: string; cname_verified: boolean; enabled?: boolean }[];
};

export type DomainRecord = { record: string; type: string; name: string; value: string; priority: number | null; ttl: number | null; status: string };

async function viewSenderDomain(apiKey: string, hostname: string): Promise<Smtp2goDomainEntry | null> {
	// SMTP2GO answers an error (not an empty list) when the sender domain does not exist: that means "not registered".
	const data = await smtp2goRequest<{ domains?: Smtp2goDomainEntry[] }>(apiKey, "/domain/view", { domain: hostname })
		.catch((error: Error) => { if (/error occurred fetching the sender domain|doesn't exist/i.test(error.message)) return { domains: [] }; throw error; });
	return data.domains?.find((entry) => entry.domain.fulldomain?.toLowerCase() === hostname.toLowerCase()) ?? null;
}

/** Targets shown to customers: our own aliases (CNAMEs we publish at mailflare.co) of SMTP2GO's dkim/return/track hosts, so the provider name never appears. */
const TARGET = { dkim: "dkim.mailflare.co", rpath: "return.mailflare.co", tracking: "track.mailflare.co" };

/** DKIM and return-path CNAMEs (plus the tracking CNAME when SMTP2GO lists one), and whether all of them verified. */
function toRecords(entry: Smtp2goDomainEntry) {
	const { domain, trackers = [] } = entry;
	const status = (verified: boolean) => (verified ? "verified" : "pending");
	const records: DomainRecord[] = [
		{ record: "DKIM", type: "CNAME", name: `${domain.dkim_selector}._domainkey.${domain.fulldomain}`, value: TARGET.dkim, priority: null, ttl: null, status: status(domain.dkim_verified) },
		{ record: "Return-Path", type: "CNAME", name: `${domain.rpath_selector}.${domain.fulldomain}`, value: TARGET.rpath, priority: null, ttl: null, status: status(domain.rpath_verified) },
		// SMTP2GO's default tracking host is link.<domain>; shown even when the API lists no tracker for the domain.
		...(trackers.length ? [] : [{ record: "Tracking", type: "CNAME", name: `link.${domain.fulldomain}`, value: TARGET.tracking, priority: null, ttl: null, status: "pending" }]),
		...trackers.map((tracker) => ({ record: "Tracking", type: "CNAME", name: tracker.fulldomain, value: TARGET.tracking, priority: null, ttl: null, status: status(tracker.cname_verified) })),
	];
	// The tracking CNAME is shown but optional: sending works once DKIM and return-path verify.
	return { status: records.filter((record) => !OPTIONAL_RECORDS.has(record.record)).every((record) => record.status === "verified") ? "verified" : "pending", records };
}

const DMARC_VALUE = "v=DMARC1; p=none;";

/** DMARC policy TXT at _dmarc.<domain>: verified when any DMARC1 policy is already published there (a stricter one is never overwritten). Recommended, not required. */
async function dmarcRecord(hostname: string): Promise<DomainRecord> {
	const { queryDns } = await import("@/lib/dns-query");
	const found = await queryDns(`_dmarc.${hostname}`, "TXT").then((values) => values.some((value) => /^\s*v=DMARC1\b/i.test(value)), () => false);
	return { record: "DMARC", type: "TXT", name: `_dmarc.${hostname}`, value: DMARC_VALUE, priority: null, ttl: null, status: found ? "verified" : "pending" };
}

/** Listed in the checklist but not needed for "verified": sending and receiving work without them. */
const OPTIONAL_RECORDS = new Set(["Tracking", "DMARC"]);

const RECEIVING_MX = [["mx.mailflare.co", 10]] as const;

/**
 * Inbound mail: one MX, our own alias at mailflare.co, so the provider behind it never appears. Verified only when no
 * other MX is preferred over (or tied with) ours, since mail would still go there. `otherMx` lists the foreign hosts.
 */
async function receivingRecords(hostname: string): Promise<{ records: DomainRecord[]; otherMx: string[] }> {
	const { queryDns } = await import("@/lib/dns-query");
	// Each answer reads "<priority> <host>."
	const found = await queryDns(hostname, "MX").then((values) => values.map((value) => {
		const parts = value.trim().split(/\s+/);
		return { priority: Number(parts[0]), host: parts[parts.length - 1].replace(/\.$/, "").toLowerCase() };
	}), () => []);
	const [[value, priority]] = RECEIVING_MX;
	const ours = found.find((mx) => mx.host === value);
	const others = found.filter((mx) => mx.host !== value && mx.host !== "");
	const verified = !!ours && others.every((mx) => mx.priority > ours.priority);
	return { records: [{ record: "Receiving", type: "MX", name: hostname, value, priority, ttl: null, status: verified ? "verified" : "pending" }], otherMx: others.map((mx) => mx.host) };
}

/** Registers the domain as an SMTP2GO sender domain (if missing) and marks it as sent through SMTP2GO. */
export async function ensureSmtp2goDomain(env: CloudflareEnv, domain: DomainRow) {
	const apiKey = await getSmtp2goApiKey(env);
	let entry = await viewSenderDomain(apiKey, domain.hostname);
	if (!entry) {
		// auto_verify off: the records are not in DNS yet; Check DNS verifies later.
		await smtp2goRequest(apiKey, "/domain/add", { domain: domain.hostname, tracking_subdomain: "link", auto_verify: false });
		entry = await viewSenderDomain(apiKey, domain.hostname);
		if (!entry) throw new Error("Domain setup did not complete, try again");
	}
	if (domain.sendingProvider !== "smtp2go" || domain.receivingProvider !== "cloudflare") {
		await getDb(env).update(domains).set({ sendingProvider: "smtp2go", receivingProvider: "cloudflare", status: "active" }).where(eq(domains.id, domain.id));
	}
	return entry;
}

/**
 * Read-only unless `verify`: is the domain registered with SMTP2GO, and what records does it list? Never creates
 * anything (the admin adds a missing domain explicitly with `ensureSmtp2goDomain`).
 */
export async function getDomainRecords(env: CloudflareEnv, domain: DomainRow, verify = false) {
	const apiKey = await getSmtp2goApiKey(env);
	let entry = await viewSenderDomain(apiKey, domain.hostname);
	if (!entry) return { hostname: domain.hostname, registered: false as const, status: "not_registered", records: [] as DomainRecord[] };
	if (verify) {
		await smtp2goRequest(apiKey, "/domain/verify", { domain: domain.hostname });
		entry = (await viewSenderDomain(apiKey, domain.hostname)) ?? entry;
	}
	const { records } = toRecords(entry);
	const receiving = await receivingRecords(domain.hostname);
	const all = [...records, ...receiving.records, await dmarcRecord(domain.hostname)];
	// Verified only when mail can be both sent and received (the tracking CNAME stays optional).
	const status = all.filter((record) => !OPTIONAL_RECORDS.has(record.record)).every((record) => record.status === "verified") ? "verified" : "pending";
	// DKIM and return-path alone: the domain can send, which shows its DNS was really set up.
	const sendingVerified = records.filter((record) => !OPTIONAL_RECORDS.has(record.record)).every((record) => record.status === "verified");
	return { hostname: domain.hostname, registered: true as const, status, sendingVerified, otherMx: receiving.otherMx, records: all.map((record) => ({ ...record, optional: OPTIONAL_RECORDS.has(record.record) })) };
}

/**
 * Mail from the platform itself (password resets, signup reminders), sent from `SYSTEM_SENDER`: it must work before a
 * workspace has set up any domain. False when the platform has no sender configured.
 */
export async function sendPlatformEmail(env: CloudflareEnv, message: { to: string; subject: string; text: string; html?: string }): Promise<boolean> {
	const sender = env.SYSTEM_SENDER?.trim();
	const apiKey = await getPlatformSmtp2goKey(env);
	if (!sender || !apiKey) return false;
	const data = await smtp2goRequest<{ failed?: number }>(apiKey, "/email/send", {
		sender, to: [message.to], subject: message.subject, text_body: message.text, ...(message.html ? { html_body: message.html } : {}),
		custom_headers: [{ header: "Auto-Submitted", value: "auto-generated" }],
	});
	if (data.failed) throw new Error("Mail delivery: send failed");
	return true;
}

export async function removeSmtp2goDomain(apiKey: string, hostname: string) {
	await smtp2goRequest(apiKey, "/domain/remove", { domain: hostname });
}
