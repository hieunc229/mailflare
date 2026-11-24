import { and, eq, isNotNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { domainDeliverability, domains } from "@/db/schema";
import { listMxRecords } from "@/lib/cloudflare-dns";
import { queryDns } from "@/lib/dns-query";
import { buildMtaStsPolicy, MTA_STS_LIMITS, nextPolicyId, normalizeMx, parseMaxAge, type MtaStsMode } from "./mta-sts";
import { DnsReadError, isManual, isZoneUnavailable, MultipleRecordsError, readTxtRecord, reportsDeps, unquote, type ReportsDeps } from "./reports-admin";

type Domain = { id: string; hostname: string; zoneId: string };
/** `queryMx`: the public MX answers (`10 host.`). `zoneMx`: the zone's own MX records in the same shape, which no resolver cache can make stale right after Mailflare changed them. */
export type MtaStsDeps = ReportsDeps & { queryMx(name: string): Promise<string[]>; zoneMx(env: CloudflareEnv, domain: Domain): Promise<string[]> };
export const mtaStsDeps: MtaStsDeps = {
	...reportsDeps,
	queryMx: (name) => queryDns(name, "MX"),
	zoneMx: async (env, domain) => (await listMxRecords(env, domain.zoneId, domain.hostname)).map((record) => `${record.priority ?? 0} ${record.content ?? ""}`),
};

export type MtaStsStatus = "off" | "testing" | "enforce" | "retiring";
export type MtaStsState = {
	host: string;
	policyUrl: string;
	mode: MtaStsMode;
	status: MtaStsStatus;
	policyId: string | null;
	mx: string[];
	/** MX hosts that are neither Cloudflare Email Routing nor Amazon SES inbound: Mailflare cannot vouch for their certificates. */
	unverifiedMx: string[];
	maxAge: number;
	/** The exact body served at `policyUrl`, so the browser can compare it with what the host returns. */
	policy: string | null;
	verifiedAt: string | null;
	retireAfter: string | null;
	/** The `_mta-sts` TXT record this change calls for; `manual` when the zone is not managed and the admin has to publish it. */
	txt?: { name: string; content: string; manual: boolean };
};
export type MtaStsResult =
	| { kind: "ok"; state: MtaStsState }
	| { kind: "error"; status: number; code: string; message: string };

const fail = (status: number, code: string, message: string): MtaStsResult => ({ kind: "error", status, code, message });
const isStsRecord = (content: string) => /^\s*v=STSv1\s*(?:;|$)/i.test(content);
const KNOWN_MX = [/\.mx\.cloudflare\.net$/, /^inbound-smtp\.[a-z0-9-]+\.amazonaws\.com$/];
const unverified = (mx: string[]) => mx.filter((host) => !KNOWN_MX.some((pattern) => pattern.test(host)));

type Row = { mode: MtaStsMode; policyId: string | null; mx: string | null; maxAge: number; servedMaxAge: number | null; verifiedAt: Date | null; retireAfter: Date | null };
const OFF: Row = { mode: "none", policyId: null, mx: null, maxAge: MTA_STS_LIMITS.defaultMaxAge, servedMaxAge: null, verifiedAt: null, retireAfter: null };

async function readRow(env: CloudflareEnv, domainId: string): Promise<Row | null> {
	const [row] = await getDb(env).select({
		mode: domainDeliverability.mtaStsMode, policyId: domainDeliverability.mtaStsPolicyId, mx: domainDeliverability.mtaStsMx,
		maxAge: domainDeliverability.mtaStsMaxAge, servedMaxAge: domainDeliverability.mtaStsServedMaxAge, verifiedAt: domainDeliverability.mtaStsVerifiedAt, retireAfter: domainDeliverability.mtaStsRetireAfter,
	}).from(domainDeliverability).where(eq(domainDeliverability.domainId, domainId)).limit(1);
	return row ?? null;
}

async function writeRow(env: CloudflareEnv, domainId: string, row: Row) {
	const values = { mtaStsMode: row.mode, mtaStsPolicyId: row.policyId, mtaStsMx: row.mx, mtaStsMaxAge: row.maxAge, mtaStsServedMaxAge: row.servedMaxAge, mtaStsVerifiedAt: row.verifiedAt, mtaStsRetireAfter: row.retireAfter, updatedAt: new Date() };
	await getDb(env).insert(domainDeliverability).values({ domainId, ...values }).onConflictDoUpdate({ target: domainDeliverability.domainId, set: values });
}

function storedMx(value: string | null): string[] {
	try {
		return normalizeMx(JSON.parse(value ?? "")) ?? [];
	} catch {
		return [];
	}
}

function toState(domain: Pick<Domain, "hostname">, row: Row | null): MtaStsState {
	const current = row ?? OFF;
	const mx = storedMx(current.mx);
	let policy: string | null = null;
	if (current.policyId && mx.length > 0) {
		try {
			policy = buildMtaStsPolicy({ mode: current.mode, mx, maxAge: current.maxAge });
		} catch {
			policy = null;
		}
	}
	const host = `mta-sts.${domain.hostname.toLowerCase()}`;
	return {
		host,
		policyUrl: `https://${host}/.well-known/mta-sts.txt`,
		mode: current.mode,
		status: !current.policyId ? "off" : current.mode === "none" ? "retiring" : current.mode,
		policyId: current.policyId,
		mx,
		unverifiedMx: unverified(mx),
		maxAge: current.maxAge,
		policy,
		verifiedAt: current.verifiedAt?.toISOString() ?? null,
		retireAfter: current.retireAfter?.toISOString() ?? null,
	};
}

export async function getMtaStsState(env: CloudflareEnv, domain: Pick<Domain, "id" | "hostname">): Promise<MtaStsState> {
	return toState(domain, await readRow(env, domain.id));
}

/** An MX answer that is not a plain host name cannot be listed in a policy, and leaving it out would make senders refuse that server. */
class InvalidMxError extends Error {
	constructor(readonly hosts: string[]) {
		super("Invalid MX host");
	}
}

/** The host names of MX answers (`10 mx.example.net.`): the valid ones, and the answers that are not plain host names (the null MX `.` is neither). */
async function readMxAnswers(domain: Pick<Domain, "hostname">, deps: MtaStsDeps): Promise<{ hosts: string[]; invalid: string[] }> {
	const answers = await deps.queryMx(domain.hostname);
	const hosts: string[] = [];
	const invalid: string[] = [];
	for (const answer of answers) {
		const host = /^\d+\s+(\S+)$/.exec(answer.trim())?.[1];
		if (host === ".") continue;
		const clean = host ? normalizeMx([host]) : null;
		if (clean) hosts.push(...clean);
		else invalid.push(answer.trim().slice(0, 100));
	}
	return { hosts: normalizeMx(hosts) ?? [], invalid: invalid.slice(0, 5) };
}

async function readMx(domain: Domain, deps: MtaStsDeps): Promise<string[]> {
	const { hosts, invalid } = await readMxAnswers(domain, deps);
	if (invalid.length > 0) throw new InvalidMxError(invalid);
	return hosts;
}

/** The live MX records next to the list the policy carries: `differs` is true when senders would be sent to a host the policy does not list (or the reverse). `{ error: true }` when DNS could not be read. */
export async function mxDrift(domain: Pick<Domain, "hostname">, state: Pick<MtaStsState, "mx">, deps: MtaStsDeps = mtaStsDeps): Promise<{ liveMx: string[]; differs: boolean } | { error: true }> {
	try {
		const { hosts, invalid } = await readMxAnswers(domain, deps);
		return { liveMx: hosts, differs: invalid.length > 0 || JSON.stringify(hosts) !== JSON.stringify(state.mx) };
	} catch {
		return { error: true };
	}
}

/**
 * Publishes, changes or retires the MTA-STS policy of a domain. The policy file is derived from the stored row. DNS is
 * written first and the row after it: a sender that fetched the policy between the two and rolled back would otherwise
 * hold a new mode under an old id and never ask again. A failed DNS write changes nothing. The id moves forward
 * whenever mode, MX list or max_age changes. Enforce needs testing first, an explicit acknowledgement and an MX list
 * that matches the one stored (a changed list goes through testing). Turning it off serves `mode: none` under a new id
 * until `now` plus the longest max_age any policy of this run was served with (RFC 8461 §8.3); the daily job then
 * deletes the record. A record at `_mta-sts` that Mailflare did not publish is never overwritten.
 */
export async function updateMtaSts(env: CloudflareEnv, domain: Domain, body: unknown, deps: MtaStsDeps = mtaStsDeps, now: Date = new Date()): Promise<MtaStsResult> {
	const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
	const mode = input?.mode;
	if (!input || (mode !== "testing" && mode !== "enforce" && mode !== "none")) return fail(400, "INVALID_BODY", "Expected { mode: \"testing\" | \"enforce\" | \"none\", maxAge?: number, acknowledgeRisk?: boolean }");
	const stored = await readRow(env, domain.id);
	const current = stored ?? OFF;
	const maxAge = input.maxAge === undefined ? current.maxAge : parseMaxAge(input.maxAge);
	if (maxAge === null) return fail(400, "INVALID_MAX_AGE", "max_age must be a whole number of seconds from 86400 to 31557600");
	const published = current.policyId !== null;
	const name = `_mta-sts.${domain.hostname}`;
	const manual = isManual(domain);
	/** The record at `_mta-sts`; undefined until it was read (a retirement reads it only when writing). */
	let existing: { id: string | null; content: string } | null | undefined;

	if (mode === "none") {
		if (!published || current.mode === "none") return { kind: "ok", state: toState(domain, stored) };
		const served = Math.max(current.servedMaxAge ?? 0, current.maxAge);
		return apply({ ...current, mode: "none", policyId: nextPolicyId(now, current.policyId), maxAge: current.maxAge, servedMaxAge: served, retireAfter: new Date(now.getTime() + served * 1000), verifiedAt: null });
	}
	if (mode === "enforce") {
		if (!published || current.mode === "none") return fail(409, "TESTING_FIRST", "Publish in testing mode first and watch the TLS reports");
		if (input.acknowledgeRisk !== true) return fail(409, "ACKNOWLEDGE_REQUIRED", "Enforce makes senders refuse to deliver to an MX host that has no valid certificate; confirm that every MX host has one");
	}

	let mx: string[];
	try {
		mx = await readMx(domain, deps);
	} catch (error) {
		if (error instanceof InvalidMxError) return fail(409, "INVALID_MX", `These MX answers are not plain host names, so they cannot be listed in a policy: ${error.hosts.join(", ")}`);
		console.error(`MTA-STS MX lookup failed for ${domain.hostname}`, error);
		return fail(502, "DNS_FAILED", "Could not read the MX records of this domain");
	}
	if (mx.length === 0) return fail(409, "NO_MX", "This domain has no MX host, so there is nothing to publish");
	if (mx.length > MTA_STS_LIMITS.maxMx) return fail(409, "TOO_MANY_MX", `The policy can list at most ${MTA_STS_LIMITS.maxMx} MX hosts`);
	const mxJson = JSON.stringify(mx);
	if (mode === "enforce" && current.mx !== mxJson) return fail(409, "MX_CHANGED_IN_ENFORCE", "The MX hosts differ from the policy in force; switch to testing to publish the new list, then enforce again");
	try {
		existing = await readTxtRecord(env, domain, name, isStsRecord, deps);
	} catch (error) {
		if (error instanceof MultipleRecordsError) return fail(409, "MULTIPLE_MTA_STS_RECORDS", "More than one MTA-STS record exists; remove the extra ones first");
		if (error instanceof DnsReadError) return fail(502, "DNS_FAILED", "Could not read the current MTA-STS record");
		throw error;
	}
	if (existing && !published) return fail(409, "MTA_STS_RECORD_EXISTS", "An MTA-STS record that Mailflare did not publish already exists; remove it first");

	const changed = !published || current.mode !== mode || current.mx !== mxJson || current.maxAge !== maxAge || current.retireAfter !== null;
	if (!changed) return { kind: "ok", state: toState(domain, stored) };
	return apply({ mode, policyId: nextPolicyId(now, current.policyId), mx: mxJson, maxAge, servedMaxAge: Math.max(published ? (current.servedMaxAge ?? current.maxAge) : 0, maxAge), verifiedAt: null, retireAfter: null });

	/** Announces the new id in DNS, then stores the row it announces; a failed DNS write leaves both as they were. */
	async function apply(next: Row): Promise<MtaStsResult> {
		const content = `v=STSv1; id=${next.policyId}`;
		if (!manual) {
			try {
				// A retirement skipped the read above, so it happens here.
				const record = existing !== undefined ? existing : await readTxtRecord(env, domain, name, isStsRecord, deps);
				if (record?.id) await deps.updateTxt(env, domain.zoneId, record.id, content);
				else await deps.createTxt(env, domain.zoneId, name, content);
			} catch (error) {
				if (mode === "none" && isZoneUnavailable(error)) return updateMtaSts(env, { ...domain, zoneId: "manual" }, body, deps, now);
				console.error(`MTA-STS record write failed for ${domain.hostname}`, error);
				return fail(502, "DNS_FAILED", "Could not change the MTA-STS record; the previous policy was kept");
			}
		}
		await writeRow(env, domain.id, next);
		return { kind: "ok", state: { ...toState(domain, next), txt: { name, content: unquote(content), manual } } };
	}
}

/** Records that the admin's browser fetched the policy from the host and it matched. Informational: it changes nothing that is served. */
export async function markMtaStsVerified(env: CloudflareEnv, domain: Domain, now: Date = new Date()): Promise<MtaStsResult> {
	const row = await readRow(env, domain.id);
	if (!row?.policyId) return fail(409, "NOT_PUBLISHED", "Publish a policy first");
	await writeRow(env, domain.id, { ...row, verifiedAt: now });
	return { kind: "ok", state: toState(domain, { ...row, verifiedAt: now }) };
}

/** Deletes the `_mta-sts` record Mailflare published. False when the zone cannot be changed from here (manual, gone or off limits): the admin removes the record. */
export async function deleteMtaStsRecord(env: CloudflareEnv, domain: Domain, deps: MtaStsDeps = mtaStsDeps): Promise<boolean> {
	if (isManual(domain)) return false;
	try {
		const records = (await deps.listTxt(env, domain.zoneId, `_mta-sts.${domain.hostname}`)).filter((record) => isStsRecord(unquote(record.content ?? "")));
		for (const record of records) if (record.id) await deps.deleteTxt(env, domain.zoneId, record.id);
		return true;
	} catch (error) {
		if (isZoneUnavailable(error)) return false;
		throw error;
	}
}

/**
 * Daily: a policy in its removal period (`mode: none`) whose `retire_after` has passed loses its `_mta-sts` record and
 * is cleared, so the host stops serving a policy. A failed delete leaves everything as it was for tomorrow. In a
 * manual zone the policy is cleared and the admin removes the record.
 */
export async function retireMtaSts(env: CloudflareEnv, now: Date, deps: MtaStsDeps = mtaStsDeps): Promise<void> {
	const due = await getDb(env).select({ domainId: domainDeliverability.domainId, hostname: domains.hostname, zoneId: domains.zoneId })
		.from(domainDeliverability).innerJoin(domains, eq(domains.id, domainDeliverability.domainId))
		.where(and(eq(domainDeliverability.mtaStsMode, "none"), isNotNull(domainDeliverability.mtaStsPolicyId), isNotNull(domainDeliverability.mtaStsRetireAfter), lte(domainDeliverability.mtaStsRetireAfter, now)));
	for (const item of due) {
		const domain = { id: item.domainId, hostname: item.hostname, zoneId: item.zoneId };
		try {
			await deleteMtaStsRecord(env, domain, deps);
			await writeRow(env, domain.id, OFF);
		} catch (error) {
			console.error(`MTA-STS retirement failed for ${domain.hostname}`, error);
		}
	}
}
