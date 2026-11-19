import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings, domains, emailSuppressions, messages } from "@/db/schema";
import { getEmailAddressList } from "@/lib/email/address";
import { newId } from "@/lib/ids";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { parseDeliveryStatus } from "./dsn";
import {
	addressDomain, cleanAddress, filterSuppressed, MAX_SUPPRESSION_DETAIL, SuppressedRecipientError,
	type SuppressionEntry, type SuppressionMode, type SuppressionReason, type SuppressionSource,
} from "./suppression-utils";

const SETTINGS_ID = "default";
/** D1 allows 100 bound parameters per statement; two more are the domain id and the confirmed flag. */
const IN_CHUNK = 90;
const DSN_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** Most addresses one returned message may add; real reports name a handful. */
const MAX_DSN_ENTRIES = 50;
const STRENGTH: Record<SuppressionReason, number> = { manual: 0, hard_bounce: 1, complaint: 2 };

/** Installation-wide mode. Reads "off" until the migration that adds the column is applied. */
export async function getSuppressionMode(env: CloudflareEnv): Promise<SuppressionMode> {
	try {
		const [row] = await getDb(env).select({ mode: appSettings.suppressionMode }).from(appSettings).where(eq(appSettings.id, SETTINGS_ID)).limit(1);
		return row?.mode === "record" || row?.mode === "enforce" ? row.mode : "off";
	} catch {
		return "off";
	}
}

export async function setSuppressionMode(env: CloudflareEnv, mode: SuppressionMode): Promise<void> {
	const values = { suppressionMode: mode, updatedAt: new Date() };
	await getDb(env).insert(appSettings).values({ id: SETTINGS_ID, ...values }).onConflictDoUpdate({ target: appSettings.id, set: values });
}

export async function domainIdForAddress(env: CloudflareEnv, address: string): Promise<string | null> {
	const email = cleanAddress(address);
	if (!email) return null;
	const [row] = await getDb(env).select({ id: domains.id }).from(domains).where(eq(domains.hostname, addressDomain(email))).limit(1);
	return row?.id ?? null;
}

/**
 * Inserts or updates one address for a domain. The reason never gets weaker (complaint beats
 * hard_bounce beats manual), and a weaker event neither replaces the stronger entry's source and
 * detail nor, for a manual entry, counts as another event.
 *
 * Only `confirmed` entries are enforced (default). An unconfirmed one (a DSN, or a Resend event naming
 * several recipients) becomes confirmed when a later confirmed event arrives, when a DSN names the
 * same address for a different original message (`evidenceRef`), or through `confirmSuppression`.
 * An unconfirmed event never alters an entry that is already confirmed, beyond counting.
 */
export async function recordSuppression(
	env: CloudflareEnv,
	input: { domainId: string; email: string; reason: SuppressionReason; source: SuppressionSource; detail?: string | null; userId?: string | null; confirmed?: boolean; evidenceRef?: string | null },
): Promise<void> {
	const now = new Date();
	const detail = input.detail?.slice(0, MAX_SUPPRESSION_DETAIL) ?? null;
	const table = emailSuppressions;
	const stronger = (Object.keys(STRENGTH) as SuppressionReason[]).filter((reason) => STRENGTH[reason] > STRENGTH[input.reason]);
	const confirmed = input.confirmed !== false;
	const evidenceRef = confirmed ? null : input.evidenceRef ?? null;
	const keepStronger = stronger.length ? sql`${table.reason} in (${sql.join(stronger.map((reason) => sql`${reason}`), sql`, `)})` : null;
	const keep = confirmed ? keepStronger : keepStronger ? sql`(${keepStronger} or ${table.confirmed})` : sql`${table.confirmed}`;
	const choose = <T,>(column: typeof table.reason | typeof table.source | typeof table.detail, value: T) =>
		keep ? sql`case when ${keep} then ${column} else ${value} end` : value;
	await getDb(env).insert(table).values({
		id: newId("sup"),
		domainId: input.domainId,
		email: input.email,
		reason: input.reason,
		source: input.source,
		detail,
		confirmed,
		evidenceRef,
		firstEventAt: now,
		lastEventAt: now,
		createdByUserId: input.userId ?? null,
	}).onConflictDoUpdate({
		target: [table.domainId, table.email],
		set: {
			reason: choose(table.reason, input.reason) as never,
			source: choose(table.source, input.source) as never,
			detail: choose(table.detail, detail) as never,
			confirmed: (confirmed ? true : evidenceRef
				? sql`(${table.confirmed} or (${table.evidenceRef} is not null and ${table.evidenceRef} <> ${evidenceRef}))`
				: sql`${table.confirmed}`) as never,
			...(input.reason === "manual" ? {} : { eventCount: sql`${table.eventCount} + 1`, lastEventAt: now }),
		},
	});
}

/** Records verified provider events for the sender's domain. Mode "off" and unknown domains record nothing. */
export async function recordSuppressionEvents(
	env: CloudflareEnv,
	input: { sender: string; source: SuppressionSource; entries: SuppressionEntry[] },
): Promise<number> {
	if (await getSuppressionMode(env) === "off") return 0;
	const domainId = await domainIdForAddress(env, input.sender);
	if (!domainId) return 0;
	for (const entry of input.entries) {
		await recordSuppression(env, { domainId, email: entry.email, reason: entry.reason, source: input.source, detail: entry.detail, confirmed: !entry.unconfirmed });
	}
	return input.entries.length;
}

/** Which of the addresses are suppressed (and confirmed, so enforceable) for the domain. */
export async function findSuppressed(env: CloudflareEnv, domainId: string, emails: string[]): Promise<Set<string>> {
	const found = new Set<string>();
	const unique = [...new Set(emails.map((email) => cleanAddress(email)).filter((email): email is string => !!email))];
	for (let offset = 0; offset < unique.length; offset += IN_CHUNK) {
		const rows = await getDb(env).select({ email: emailSuppressions.email }).from(emailSuppressions)
			.where(and(eq(emailSuppressions.domainId, domainId), eq(emailSuppressions.confirmed, true), inArray(emailSuppressions.email, unique.slice(offset, offset + IN_CHUNK))));
		for (const row of rows) found.add(row.email);
	}
	return found;
}

/**
 * A returned message counts only when it names a Message-ID of a message we sent from this mailbox
 * in the last 30 days, and only for recipients we actually wrote to. Anyone can mail a mailbox a
 * forged bounce; this is what stops it from suppressing arbitrary addresses.
 *
 * That check is not enough on its own: a co-recipient of a message we sent has its Message-ID and the
 * other addresses, so it can forge a DSN for them. A DSN entry is therefore stored unconfirmed and
 * enforced only once a second DSN names the same address for a different original message, or an
 * admin confirms it. Mode "off" returns before the message is parsed.
 */
export async function recordDsnBounces(env: CloudflareEnv, input: { mailboxId: string; raw: ArrayBuffer }): Promise<number> {
	if (await getSuppressionMode(env) === "off") return 0;
	const status = parseDeliveryStatus(input.raw);
	if (!status?.originalMessageId) return 0;
	const failed = status.recipients.filter((recipient) => recipient.action === "failed" && /^5\.\d+\.\d+$/.test(recipient.status));
	if (!failed.length) return 0;

	const id = status.originalMessageId;
	const [sent] = await getDb(env).select({ from: messages.fromAddr, to: messages.toAddr, cc: messages.ccAddr, bcc: messages.bccAddr }).from(messages).where(and(
		eq(messages.mailboxId, input.mailboxId),
		eq(messages.direction, "outbound"),
		inArray(messages.providerMessageId, [id, `<${id}>`]),
		gte(messages.createdAt, new Date(Date.now() - DSN_LOOKBACK_MS)),
	)).limit(1);
	if (!sent) return 0;
	const domainId = await domainIdForAddress(env, sent.from);
	if (!domainId) return 0;

	const written = new Set(getEmailAddressList([sent.to, sent.cc, sent.bcc].filter(Boolean).join(", ")));
	const entries = new Map<string, string>();
	for (const recipient of failed) {
		const email = cleanAddress(recipient.finalRecipient);
		if (email && written.has(email) && !entries.has(email) && entries.size < MAX_DSN_ENTRIES) entries.set(email, recipient.diagnostic);
	}
	for (const [email, diagnostic] of entries) {
		await recordSuppression(env, { domainId, email, reason: "hard_bounce", source: "dsn", detail: diagnostic, confirmed: false, evidenceRef: id });
	}
	return entries.size;
}

/** Suppressed addresses among the recipients; always empty unless the mode is "enforce". */
async function enforcedSuppressions(env: CloudflareEnv, from: string, recipients: string[]): Promise<Set<string>> {
	if (await getSuppressionMode(env) !== "enforce") return new Set();
	const domainId = await domainIdForAddress(env, from);
	return domainId ? findSuppressed(env, domainId, recipients) : new Set();
}

/** Refuses a send to any suppressed recipient of the sending domain (mode "enforce" only). */
export async function assertNoSuppressedRecipients(env: CloudflareEnv, from: string, recipients: string[]): Promise<void> {
	const suppressed = await enforcedSuppressions(env, from, recipients);
	if (!suppressed.size) return;
	const blocked = new Set<string>();
	for (const recipient of recipients) {
		const address = cleanAddress(recipient);
		if (address && suppressed.has(address)) blocked.add(address);
	}
	throw new SuppressedRecipientError([...blocked]);
}

/** Same refusal for features that store something before sending (calendar invitations): call it first, so nothing is half-done. */
export async function assertInviteesAllowed(
	env: CloudflareEnv,
	input: { userId: string; mailboxId: string; from: string; attendees: string[] },
): Promise<void> {
	const sender = await getAuthorizedSenderAddress(env, input);
	await assertNoSuppressedRecipients(env, sender.fromAddr, input.attendees);
}

/** Delivery-time twin of the check above: removes suppressed recipients instead of refusing. */
export async function dropSuppressedRecipients(
	env: CloudflareEnv,
	from: string,
	lists: { to: string[]; cc: string[]; bcc: string[] },
): Promise<{ to: string[]; cc: string[]; bcc: string[]; dropped: string[] }> {
	const suppressed = await enforcedSuppressions(env, from, [...lists.to, ...lists.cc, ...lists.bcc]);
	if (!suppressed.size) return { ...lists, dropped: [] };
	const to = filterSuppressed(lists.to, suppressed);
	const cc = filterSuppressed(lists.cc, suppressed);
	const bcc = filterSuppressed(lists.bcc, suppressed);
	return { to: to.allowed, cc: cc.allowed, bcc: bcc.allowed, dropped: [...new Set([...to.suppressed, ...cc.suppressed, ...bcc.suppressed])] };
}
