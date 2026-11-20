import { getEmailAddress, normalizeEmailAddress, splitEmailAddressList } from "@/lib/email/address";

export type SuppressionMode = "off" | "record" | "enforce";
export type SuppressionReason = "hard_bounce" | "complaint" | "manual";
export type SuppressionSource = "resend" | "ses" | "dsn" | "admin";
/**
 * What a provider event can add: manual entries come from the admin UI only. `unconfirmed` entries are
 * stored but not enforced (see `recordSuppression`); an entry without the flag is enforced.
 */
export type SuppressionEntry = { email: string; reason: "hard_bounce" | "complaint"; detail?: string; unconfirmed?: true };
export type SuppressionEvent = { sender: string; entries: SuppressionEntry[] };

export const SUPPRESSED_RECIPIENT_CODE = "SUPPRESSED_RECIPIENT";
export const MAX_SUPPRESSION_DETAIL = 300;

/** Thrown before anything is stored or sent when a recipient is on the sending domain's suppression list. */
export class SuppressedRecipientError extends Error {
	readonly code = SUPPRESSED_RECIPIENT_CODE;
	constructor(readonly addresses: string[]) {
		super(`These addresses bounced or reported spam: ${addresses.join(", ")}`);
	}
}

/** Body of the 422 that /api/send and /api/v1/send answer with. */
export function suppressedRecipientBody(error: SuppressedRecipientError) {
	return { error: error.message, code: error.code, addresses: error.addresses };
}

/**
 * JMAP EmailSubmission/set `notCreated` entry (RFC 8621 section 7.5). `recipientHeaders` are the
 * client's To/Cc/Bcc values: the addresses are echoed the way the client wrote them, not lower-cased.
 */
export function suppressedSubmissionError(error: SuppressedRecipientError, recipientHeaders: (string | null | undefined)[] = []) {
	const written = new Map<string, string>();
	for (const header of recipientHeaders) {
		for (const recipient of splitEmailAddressList(header)) {
			const address = getEmailAddress(recipient).trim();
			if (!written.has(address.toLowerCase())) written.set(address.toLowerCase(), address);
		}
	}
	const invalidRecipients = error.addresses.map((address) => written.get(address) ?? address);
	return { type: "invalidRecipients", description: new SuppressedRecipientError(invalidRecipients).message, invalidRecipients };
}

const looksLikeAddress = (value: string) => /^[^\s@<>]+@[^\s@<>]+$/.test(value);

/** Bare lower-case address, or null for anything that is not one. */
export function cleanAddress(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const address = normalizeEmailAddress(value);
	return looksLikeAddress(address) ? address : null;
}

export const addressDomain = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

const truncate = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_SUPPRESSION_DETAIL) : undefined;

/** Splits header-style recipients into those still allowed (original entries kept) and the suppressed bare addresses. */
export function filterSuppressed(recipients: string[], suppressed: ReadonlySet<string>): { allowed: string[]; suppressed: string[] } {
	const allowed: string[] = [];
	const dropped = new Set<string>();
	for (const recipient of recipients) {
		const address = normalizeEmailAddress(recipient);
		if (suppressed.has(address)) dropped.add(address);
		else allowed.push(recipient.trim());
	}
	return { allowed, suppressed: [...dropped] };
}

function toEntries(addresses: unknown, reason: SuppressionEntry["reason"], detail?: string, unconfirmed = false): SuppressionEntry[] {
	if (!Array.isArray(addresses)) return [];
	const seen = new Set<string>();
	const entries: SuppressionEntry[] = [];
	for (const value of addresses) {
		const email = cleanAddress(value);
		if (!email || seen.has(email)) continue;
		seen.add(email);
		entries.push({ email, reason, ...(detail ? { detail } : {}), ...(unconfirmed ? { unconfirmed: true as const } : {}) });
	}
	return entries;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Resend `email.bounced` / `email.complained`. Resend documents `data.bounce.type` as
 * `Permanent` or `Temporary`; older material says `Transient`, so both soft types are
 * skipped and a bounce without a type counts as permanent (the event itself means the
 * receiving server permanently rejected the message).
 *
 * The payload has `to` (every recipient of the message) but no field naming which one bounced or
 * complained. With one recipient the event is unambiguous; with several, naming all of them would let
 * one bad address block the rest, so those entries are stored unconfirmed and are not enforced.
 */
export function mapResendEvent(body: unknown): SuppressionEvent | null {
	if (!isObject(body) || !isObject(body.data)) return null;
	const sender = cleanAddress(body.data.from);
	if (!sender) return null;
	const to = body.data.to;
	const ambiguous = Array.isArray(to) && new Set(to.map((value) => (typeof value === "string" ? value.trim().toLowerCase() : value))).size > 1;
	let entries: SuppressionEntry[];
	if (body.type === "email.complained") {
		entries = toEntries(to, "complaint", undefined, ambiguous);
	} else if (body.type === "email.bounced") {
		const bounce = isObject(body.data.bounce) ? body.data.bounce : {};
		const type = typeof bounce.type === "string" ? bounce.type.trim().toLowerCase() : "";
		if (type === "transient" || type === "temporary") return null;
		entries = toEntries(to, "hard_bounce", truncate(bounce.message), ambiguous);
	} else return null;
	return entries.length ? { sender, entries } : null;
}

/** SES feedback delivered through SNS: permanent bounces and complaints only. */
export function mapSesNotification(message: string): SuppressionEvent | null {
	let parsed: unknown;
	try { parsed = JSON.parse(message); } catch { return null; }
	if (!isObject(parsed) || !isObject(parsed.mail)) return null;
	const sender = cleanAddress(parsed.mail.source);
	if (!sender) return null;
	const entries: SuppressionEntry[] = [];
	if (parsed.notificationType === "Bounce" && isObject(parsed.bounce) && parsed.bounce.bounceType === "Permanent" && Array.isArray(parsed.bounce.bouncedRecipients)) {
		for (const recipient of parsed.bounce.bouncedRecipients) {
			if (!isObject(recipient)) continue;
			entries.push(...toEntries([recipient.emailAddress], "hard_bounce", truncate(recipient.diagnosticCode)));
		}
	} else if (parsed.notificationType === "Complaint" && isObject(parsed.complaint) && Array.isArray(parsed.complaint.complainedRecipients)) {
		for (const recipient of parsed.complaint.complainedRecipients) {
			if (!isObject(recipient)) continue;
			entries.push(...toEntries([recipient.emailAddress], "complaint"));
		}
	}
	return entries.length ? { sender, entries } : null;
}
