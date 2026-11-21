import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { imapMessageFlags, messages } from "@/db/schema";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { storeMessageAttachments } from "@/lib/email/attachments";
import { boundParsedEmail } from "@/lib/email/inbound-limits";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { MimeLimitError, buildSnippet, parseRawMime, type ParsedEmail } from "@/lib/email/parse";
import { resolveThreadId } from "@/lib/email/threading";
import { getImportMessagePlacement, getImportMessageUserId } from "@/lib/import/destination";
import type { ImportDestination } from "@/lib/import/destination-types";
import { newId } from "@/lib/ids";
import { importDraftFromBytes } from "@/lib/jmap/emails";
import { encodeMailboxRef } from "@/lib/jmap/ids";
import { imapContext, type ImapIdentity } from "./auth";
import { no } from "./errors";
import { MAX_KEYWORDS, type ParsedFlags } from "./flags";
import { findSubmission } from "./sent-dedupe";
import { syncMailbox } from "./sync";
import { uidsOf, type Destination } from "./transfer";

/**
 * APPEND (spec 8.6). Where the message goes decides the path:
 *  - Drafts: the JMAP `Email/import` code (`importDraftFromBytes`): the sender must be an address the login may
 *    send from, the bytes are kept verbatim under `drafts/` (a draft is always served synthesized, spec 8.5).
 *  - Sent: first the sent-copy dedupe; otherwise stored as a sent message.
 *  - everything else: stored like an imported message (same placement rules, threading and contact handling as
 *    `importMessagesToMailbox`).
 * The message is parsed with the same limits as every other mail, stored column values are bounded and kept
 * to one line, so nothing in them can start a new header later, and the raw bytes stay as sent.
 */
export type AppendInput = { raw: Buffer; flags: ParsedFlags; internalDate: Date | null };
export type AppendResult = { uidvalidity: number; uid: number };

const ONE_LINE = /[\r\n\0\u2028\u2029]+/g;
const oneLine = (value: string | null): string | null => (value === null ? null : value.replace(ONE_LINE, " ").trim());

/** The parsed message with every header-derived value cut to the column budgets and to a single line. */
export function cleanParsed(parsed: ParsedEmail): ParsedEmail {
	const bounded = boundParsedEmail(parsed);
	return {
		...bounded,
		subject: oneLine(bounded.subject),
		messageId: oneLine(bounded.messageId),
		fromAddr: oneLine(bounded.fromAddr),
		toAddr: oneLine(bounded.toAddr),
		ccAddr: oneLine(bounded.ccAddr),
		bccAddr: oneLine(bounded.bccAddr),
		replyTo: oneLine(bounded.replyTo),
		inReplyTo: oneLine(bounded.inReplyTo),
		references: bounded.references.map((id) => oneLine(id)!).filter(Boolean),
	};
}

const SECTIONS: Record<string, "inbox" | "sent" | "drafts" | "archived" | "spam" | "trash"> = { inbox: "inbox", sent: "sent", drafts: "drafts", archive: "archived", junk: "spam", trash: "trash" };

function destinationOf(dest: Destination): ImportDestination {
	return dest.key.startsWith("f:") ? { type: "folder", folderId: dest.key.slice(2) } : { type: "system", section: SECTIONS[dest.key] };
}

const arrayBufferOf = (raw: Buffer): ArrayBuffer => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;

async function parse(raw: Buffer): Promise<ParsedEmail> {
	try {
		return await parseRawMime(arrayBufferOf(raw));
	} catch (error) {
		if (error instanceof MimeLimitError) throw no("The message is too complex for this server to store", "CANNOT");
		throw no("The message is not valid MIME", "CANNOT");
	}
}

export async function appendMessage(env: CloudflareEnv, identity: ImapIdentity, dest: Destination, input: AppendInput): Promise<AppendResult> {
	if (input.raw.length === 0) throw no("The message is empty", "CANNOT");
	if (input.flags.keywords.length > MAX_KEYWORDS) throw no("A message may have at most 50 keywords", "LIMIT");
	const db = getDb(env);
	// The folder's state exists before the message does, so the message is indexed by the change log (which keeps the flags written below), not by a rebuild.
	await syncMailbox(env, dest.mailboxId);
	let id: string;
	if (dest.key === "drafts") id = await appendDraft(env, identity, dest, input);
	else {
		const parsed = cleanParsed(await parse(input.raw));
		if (dest.key === "sent") {
			// A copy of what the submission service just sent is not stored again.
			const known = findSubmission(identity.userId, parsed.messageId);
			if (known && known.mailboxId === dest.mailboxId) {
				const { uidvalidity, uids } = await uidsOf(env, dest.mailboxId, "sent", [known.messageId]);
				if (uids[0] !== null) return { uidvalidity, uid: uids[0] };
			}
		}
		id = await storeMessage(env, identity, dest, input, parsed);
	}
	try {
		const { flags } = input;
		if (flags.answered || flags.forwarded || flags.deleted || flags.keywords.length) {
			await db.insert(imapMessageFlags).values({ messageId: id, answered: flags.answered, forwarded: flags.forwarded, deleted: flags.deleted, keywords: JSON.stringify(flags.keywords) });
		}
	} catch (error) {
		console.error(`IMAP APPEND could not store the flags of ${id}`, error);
		const [row] = await db.select().from(messages).where(eq(messages.id, id));
		if (row) await deleteMessageWithObjects(env, db, id, row.rawR2Key).catch(() => undefined);
		throw no("The message could not be stored", "SERVERBUG");
	}
	const { uidvalidity, uids } = await uidsOf(env, dest.mailboxId, dest.key, [id]);
	if (uids[0] === null) throw no("The message was stored but is not visible in that folder", "SERVERBUG");
	return { uidvalidity, uid: uids[0] };
}

async function appendDraft(env: CloudflareEnv, identity: ImapIdentity, dest: Destination, input: AppendInput): Promise<string> {
	const ctx = imapContext(env, identity.auth);
	const writable = new Set([dest.mailboxId]);
	const result = await importDraftFromBytes(
		ctx,
		arrayBufferOf(input.raw),
		{
			mailboxIds: { [encodeMailboxRef({ kind: "role", mailboxId: dest.mailboxId, role: "drafts" })]: true },
			keywords: { ...(input.flags.seen ? { $seen: true } : {}), ...(input.flags.flagged ? { $flagged: true } : {}) },
			receivedAt: input.internalDate?.toISOString(),
		},
		writable,
		cleanParsed,
	);
	if ("error" in result) {
		const { type, description } = result.error;
		if (type === "tooLarge") throw no("The message is too large for a draft", "TOOBIG");
		if (type === "forbidden") throw no("You may not send from that address, so it cannot be saved as a draft", "NOPERM");
		throw no(type === "invalidEmail" ? (description ?? "The message is not valid") : "The draft could not be stored", "CANNOT");
	}
	return result.id;
}

async function storeMessage(env: CloudflareEnv, identity: ImapIdentity, dest: Destination, input: AppendInput, parsed: ParsedEmail): Promise<string> {
	const db = getDb(env);
	const destination = destinationOf(dest);
	const placement = getImportMessagePlacement(destination);
	const id = newId("msg");
	const rawR2Key = `imports/${id}.eml`;
	const fromAddr = parsed.fromAddr ?? "unknown";
	const toAddr = parsed.toAddr ?? "";
	await db.insert(messages).values({
		id,
		userId: getImportMessageUserId(destination, identity.userId, dest.ownerUserId),
		mailboxId: dest.mailboxId,
		folderId: placement.folderId,
		direction: placement.direction,
		providerMessageId: parsed.messageId,
		fromAddr,
		toAddr,
		ccAddr: parsed.ccAddr,
		bccAddr: placement.direction === "outbound" ? parsed.bccAddr : null,
		replyTo: parsed.replyTo,
		subject: parsed.subject,
		snippet: buildSnippet(parsed.text, parsed.html),
		textBody: parsed.text,
		htmlBody: parsed.html,
		rawR2Key,
		status: placement.status,
		// What a client appends to Sent is what it sent, so it is read unless it says otherwise.
		read: input.flags.seen || placement.direction === "outbound",
		starred: input.flags.flagged,
		threadId: await resolveThreadId(db, { mailboxId: dest.mailboxId, messageId: parsed.messageId, inReplyTo: parsed.inReplyTo, references: parsed.references }),
		inReplyTo: parsed.inReplyTo,
		references: parsed.references.length ? parsed.references.join(" ") : null,
		createdAt: input.internalDate ?? parsed.date ?? new Date(),
	});
	try {
		await env.BUCKET.put(rawR2Key, arrayBufferOf(input.raw), { httpMetadata: { contentType: "message/rfc822" } });
		// The whole message is already capped by APPENDLIMIT; imports skip the composer's attachment limits too.
		await storeMessageAttachments(env, id, parsed.attachments, { validate: false });
	} catch (error) {
		await deleteMessageWithObjects(env, db, id, rawR2Key).catch((cleanup) => console.error(`IMAP APPEND could not remove the partial message ${id}`, cleanup));
		console.error("IMAP APPEND failed", error);
		throw no("The message could not be stored", "SERVERBUG");
	}
	// The contact is a by-product; the message is stored either way.
	await upsertContactFromAddress(env, { userId: identity.userId, address: placement.direction === "outbound" ? toAddr : fromAddr, source: placement.direction === "outbound" ? "outbound" : "inbound" }).catch((error) => console.warn("IMAP APPEND contact update failed", error));
	return id;
}
