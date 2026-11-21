import { getDb } from "@/db";
import { getSendErrorStatus } from "@/app/api/send/error-utils";
import { MAX_ATTACHMENT_COUNT } from "@/lib/email/attachments";
import { formatEmailAddress, getEmailAddress, parseEmailAddressParts, splitEmailAddressList } from "@/lib/email/address";
import { MIME_LIMITS } from "@/lib/email/mime-preflight";
import { MimeLimitError, parseRawMime } from "@/lib/email/parse";
import { deliveryFailureOf, sendEmail } from "@/lib/email/send";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { listJmapMailboxes, listSendableAddresses } from "@/lib/jmap/access";
import { imapContext, type ImapIdentity } from "./auth";
import { ImapError } from "./errors";
import { Gate } from "./gate";
import { rememberSubmission } from "./sent-dedupe";

/**
 * Accepting a message from a mail app on the submission ports (spec 9.2). The message is not relayed as it
 * arrived: it is parsed and handed to `sendEmail`, the same path the web composer uses, so the outgoing limits,
 * provider choice, DKIM, the Sent copy and contact collection are the ones every other send has. What this
 * module adds is everything that is specific to a mail app: who the login may send as, which recipients the
 * envelope names (and which of them are Bcc), refusing what re-composing would damage, and the hourly caps.
 */
export class SubmissionError extends Error {
	constructor(
		readonly responseCode: number,
		message: string,
	) {
		super(message);
	}
}
const refuse = (code: number, message: string) => new SubmissionError(code, message);

/** The limits of the web composer's send form (`sendEmailSchema`), applied to what a mail app sends. */
export const MAX_SUBJECT_CHARS = 500;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_RECIPIENTS = 50;
const SIZE_OVERHEAD = 1.35;
const HARD_SIZE_CAP = 36 * 1024 * 1024;

/** The largest message the listener takes: the outgoing limit plus what MIME encoding adds, never above 36 MiB. */
export const submissionSizeLimit = (outboundMaxMb: number): number => Math.min(Math.floor(outboundMaxMb * 1_000_000 * SIZE_OVERHEAD), HARD_SIZE_CAP);

/** Messages parsed at the same time in one process, and how many more may wait. */
export const MAX_CONCURRENT_PARSES = 2;
export const MAX_QUEUED_PARSES = 32;
export const submissionGate = new Gate(MAX_CONCURRENT_PARSES, MAX_QUEUED_PARSES);

// ---- addresses ----

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UNSAFE_DOMAIN = /[\s<>@",;:()[\]\\/?#%\u0000-\u001f\u007f]/;

/**
 * The plain, lower-cased address for a mailbox, or null when it is not one we will put on a message: ASCII local
 * part of dot-atoms, a domain of at least two labels (an internationalised one is converted to punycode), nothing
 * that could end a header value or an SMTP command. Display names, comments and groups are not addresses.
 */
export function normalizeAddress(value: string): string | null {
	const text = value.trim();
	const at = text.lastIndexOf("@");
	if (at < 1 || text.length > 254) return null;
	const local = text.slice(0, at);
	const domain = text.slice(at + 1);
	if (local.length > 64 || !LOCAL_PART.test(local) || !domain || UNSAFE_DOMAIN.test(domain)) return null;
	let ascii: string;
	try {
		ascii = new URL(`http://${domain}`).hostname.toLowerCase();
	} catch {
		return null;
	}
	const labels = ascii.split(".");
	if (ascii.length > 253 || labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
	return `${local.toLowerCase()}@${ascii}`;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f\u2028\u2029]+/g;
/** A header-derived value on one line: line breaks and other control characters become a space. */
const flatten = (value: string | null | undefined): string => (value ?? "").replace(CONTROL, " ").trim();

// ---- the message's own top-level headers ----

/** Unfolded top-level headers by lower-case name, read from the first 64 KiB (the parser's own header limit). */
function topHeaders(raw: Buffer): Map<string, string[]> {
	const text = raw.subarray(0, MIME_LIMITS.maxHeaderBytes).toString("latin1");
	const end = text.search(/\r?\n\r?\n/);
	const block = (end >= 0 ? text.slice(0, end) : text).replace(/\r?\n[ \t]+/g, " ");
	const headers = new Map<string, string[]>();
	for (const line of block.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const name = line.slice(0, colon).trim().toLowerCase();
		headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()]);
	}
	return headers;
}

const SIGNED_OR_ENCRYPTED = new Set(["multipart/signed", "multipart/encrypted", "application/pkcs7-mime", "application/x-pkcs7-mime"]);

// ---- who the login may send as ----

/** Every address the login may send from, with the mailbox it belongs to: write access only, the login mailbox first. */
async function sendableAddresses(env: CloudflareEnv, identity: ImapIdentity): Promise<Map<string, string>> {
	const ctx = imapContext(env, identity.auth);
	const mailboxes = (await listJmapMailboxes(ctx)).filter((mailbox) => mailbox.permission !== "read_only");
	mailboxes.sort((a, b) => Number(b.id === identity.loginMailboxId) - Number(a.id === identity.loginMailboxId));
	const addresses = new Map<string, string>();
	for (const mailbox of mailboxes) {
		for (const address of await listSendableAddresses(ctx, mailbox)) if (!addresses.has(address.toLowerCase())) addresses.set(address.toLowerCase(), mailbox.id);
	}
	return addresses;
}

const NOT_ALLOWED = "Sender address not allowed";

/** MAIL FROM: must be an address the login may send as. Returns the mailbox it belongs to. */
export async function authorizeMailFrom(env: CloudflareEnv, identity: ImapIdentity, address: string): Promise<string> {
	if (!address.trim()) throw refuse(550, "A sender address is required");
	const normalized = normalizeAddress(address);
	const mailboxId = normalized ? (await sendableAddresses(env, identity)).get(normalized) : undefined;
	if (!mailboxId) throw refuse(550, NOT_ALLOWED);
	return mailboxId;
}

// ---- hourly limits ----

type Use = { at: number; recipients: number };

/**
 * Messages and recipients one account may submit per sliding window (an hour). In memory, per process, like the
 * rest of the IMAP/submission state (spec section 2); bounded in the number of accounts it remembers.
 */
export class SubmissionLimiter {
	private readonly users = new Map<string, Use[]>();

	constructor(
		readonly maxMessages: number,
		readonly maxRecipients: number,
		readonly windowMs = 60 * 60 * 1000,
		readonly maxUsers = 10_000,
	) {}

	get size(): number {
		return this.users.size;
	}

	private live(userId: string, now: number): Use[] {
		const list = (this.users.get(userId) ?? []).filter((use) => now - use.at < this.windowMs);
		if (list.length) this.users.set(userId, list);
		else this.users.delete(userId);
		return list;
	}

	/** Whether one more message could still be taken (checked early, before the message data is read). */
	hasRoom(userId: string, now = Date.now()): boolean {
		return this.live(userId, now).length < this.maxMessages;
	}

	/** Takes one message with `recipients` recipients; false when either cap would be passed. */
	take(userId: string, recipients: number, now = Date.now()): boolean {
		const list = this.live(userId, now);
		if (list.length >= this.maxMessages || list.reduce((total, use) => total + use.recipients, 0) + recipients > this.maxRecipients) return false;
		this.users.delete(userId);
		this.users.set(userId, [...list, { at: now, recipients }]);
		if (this.users.size > this.maxUsers) {
			for (const id of [...this.users.keys()]) this.live(id, now);
			for (const id of this.users.keys()) {
				if (this.users.size <= this.maxUsers) break;
				this.users.delete(id);
			}
		}
		return true;
	}
}

// ---- accepting a message ----

export type Submission = { mailFrom: string; recipients: string[]; raw: Buffer; ip: string | null };

const arrayBufferOf = (raw: Buffer): ArrayBuffer => (raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength ? raw.buffer : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)) as ArrayBuffer;

async function parse(raw: Buffer) {
	try {
		return await submissionGate.run(() => parseRawMime(arrayBufferOf(raw)));
	} catch (error) {
		if (error instanceof ImapError) throw refuse(451, "Server busy, try again later");
		if (error instanceof MimeLimitError) throw refuse(554, "The message is too complex for this server to send");
		throw refuse(554, "The message is not valid MIME");
	}
}

const MESSAGE_ID = /^[\x21-\x3b\x3d\x3f-\x7e]{1,512}$/;
const cleanIds = (ids: string[]) => ids.filter((id) => MESSAGE_ID.test(id)).slice(-20);

/** Entries of a parsed address header whose address is in `allowed`, rebuilt as `"Name" <address>` with the name on one line. */
function headerRecipients(header: string | null, allowed: Set<string>, taken: Set<string>): string[] {
	const entries: string[] = [];
	for (const entry of splitEmailAddressList(flatten(header))) {
		const { name, address: written } = parseEmailAddressParts(entry);
		const address = normalizeAddress(written);
		if (!address || !allowed.has(address) || taken.has(address)) continue;
		taken.add(address);
		entries.push(formatEmailAddress(address, flatten(name).slice(0, 200)));
	}
	return entries;
}

/** A Content-ID as a provider wants it (what `cid:` in the HTML names): without the angle brackets, nothing that could break a header. */
const contentIdOf = (value: string | null | undefined): string | null => {
	const id = flatten(value).replace(/^<|>$/g, "");
	return /^[^\s<>"]{1,255}$/.test(id) ? id : null;
};

// Messages a re-composition would damage or send under a name that is not ours to vouch for: these send errors are final.
const FINAL_SEND_ERRORS = /^(At least one recipient|A message can (have|include) at most|Sending is not set up|Attachments exceed|Subject exceeds|Headers exceed|.* exceeds the \d+ MB attachment limit)/;

function sendFailure(error: unknown, refused: { final: boolean } | null): SubmissionError {
	if (refused) {
		// The provider answered: a final refusal is not worth a retry (each retry would take another hourly slot).
		console.error("SMTP submission could not send", error);
		return refused.final ? refuse(554, "The sending service refused the message") : refuse(451, "Temporary failure, try again later");
	}
	const message = error instanceof Error ? error.message : "";
	const status = getSendErrorStatus(message);
	if (status === 403) return refuse(550, NOT_ALLOWED);
	if (status === 400 || FINAL_SEND_ERRORS.test(message)) return refuse(554, message);
	console.error("SMTP submission could not send", error);
	return refuse(451, "Temporary failure, try again later");
}

export async function submitMessage(env: CloudflareEnv, identity: ImapIdentity, input: Submission, limiter: SubmissionLimiter): Promise<{ messageId: string }> {
	if (input.raw.length === 0) throw refuse(554, "The message is empty");
	const headers = topHeaders(input.raw);
	const contentType = /^\s*([a-z0-9.+-]+\/[a-z0-9.+-]+)/i.exec(headers.get("content-type")?.[0] ?? "")?.[1]?.toLowerCase();
	if (contentType && SIGNED_OR_ENCRYPTED.has(contentType)) throw refuse(554, "Signed or encrypted mail cannot be sent through Mailflare's submission service");
	const fromHeaders = headers.get("from") ?? [];
	if (fromHeaders.length > 1 || splitEmailAddressList(fromHeaders[0]).length > 1) throw refuse(550, "The message must have exactly one From address");
	if (fromHeaders.length === 0) throw refuse(550, "The message has no From address");

	const parsed = await parse(input.raw);

	// Who: the From address and the envelope sender must both be ones the login may send as, from the same mailbox.
	const fromAddress = parsed.fromAddr ? normalizeAddress(getEmailAddress(parsed.fromAddr)) : null;
	const allowed = await sendableAddresses(env, identity);
	const mailboxId = fromAddress ? allowed.get(fromAddress) : undefined;
	const envelopeAddress = normalizeAddress(input.mailFrom);
	if (!fromAddress || !mailboxId || !envelopeAddress || allowed.get(envelopeAddress) !== mailboxId) throw refuse(550, NOT_ALLOWED);
	const access = await getMailboxAccessLevel(getDb(env), identity.auth.user, mailboxId);
	if (!access?.canSendOnBehalf) throw refuse(550, NOT_ALLOWED);

	// To whom: the envelope decides. Header recipients nobody named in RCPT are dropped; envelope recipients the
	// headers do not show are Bcc.
	const envelope = new Set<string>();
	for (const written of input.recipients) {
		const address = normalizeAddress(written);
		if (!address) throw refuse(553, "A recipient address is not valid");
		envelope.add(address);
	}
	if (envelope.size === 0) throw refuse(554, "The message has no recipients");
	if (envelope.size > MAX_RECIPIENTS) throw refuse(554, `A message can have at most ${MAX_RECIPIENTS} recipients`);
	const shown = new Set<string>();
	const to = headerRecipients(parsed.toAddr, envelope, shown);
	const cc = headerRecipients(parsed.ccAddr, envelope, shown);
	if (to.length === 0) throw refuse(554, "The message needs at least one To recipient that is also a recipient of the envelope");
	const bcc = [...envelope].filter((address) => !shown.has(address));

	// What: the limits of the web composer, plus the shapes re-composing cannot carry.
	const subject = flatten(parsed.subject) || "(no subject)";
	if (subject.length > MAX_SUBJECT_CHARS) throw refuse(554, `Subject exceeds ${MAX_SUBJECT_CHARS} characters`);
	if ((parsed.text?.length ?? 0) > MAX_BODY_BYTES || (parsed.html?.length ?? 0) > MAX_BODY_BYTES) throw refuse(554, "The message body is too large to send");
	if (!parsed.text && !parsed.html && parsed.attachments.length === 0) throw refuse(554, "The message has no text or HTML content");
	if (parsed.attachments.length > MAX_ATTACHMENT_COUNT) throw refuse(554, `A message can include at most ${MAX_ATTACHMENT_COUNT} attachments`);

	if (!limiter.take(identity.userId, envelope.size)) throw refuse(450, "Sending limit reached, try again later");

	let result: { messageId: string };
	try {
		result = await sendEmail(env, {
			userId: identity.userId,
			from: fromAddress,
			to,
			cc,
			bcc,
			subject,
			text: parsed.text ?? undefined,
			html: parsed.html ?? undefined,
			inReplyTo: parsed.inReplyTo && MESSAGE_ID.test(parsed.inReplyTo) ? parsed.inReplyTo : null,
			references: cleanIds(parsed.references),
			mailboxId,
			attachments: parsed.attachments.map((attachment) => ({ ...attachment, filename: flatten(attachment.filename) || "attachment", contentId: contentIdOf(attachment.contentId) })),
			publicOrigin: env.APP_URL,
		});
	} catch (error) {
		const delivery = deliveryFailureOf(error);
		if (!delivery?.providerAccepted) throw sendFailure(error, delivery);
		// The provider has the message: an error now would make the client send it a second time.
		console.error("SMTP submission: the message was sent but recording it failed", error);
		result = { messageId: delivery.messageId };
	}

	rememberSubmission(identity.userId, flatten(parsed.messageId), result.messageId, mailboxId);
	try {
		await createAuditLog(env, { actorUserId: identity.userId, mailboxId, messageId: result.messageId, action: "email.submit", metadata: { keyId: identity.keyId, ip: input.ip ?? "Unknown" } });
	} catch (error) {
		// The message is already out; a missing audit line must not turn that into a failure the client would retry.
		console.error("SMTP submission audit failed", error);
	}
	return result;
}
