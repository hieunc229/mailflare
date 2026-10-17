import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { emailChangesSince, threadChangesSince } from "./changes";
import { messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { joinEmailAddressList } from "@/lib/email/address";
import { resolveThreadId } from "@/lib/email/threading";
import { storeMessageAttachments } from "@/lib/email/attachments";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { LIMITS, KEYWORD_FLAGGED, KEYWORD_SEEN } from "./constants";
import { JmapError, invalidArguments } from "./errors";
import { decodeBlobId, decodeMailboxRef, roleToStatus } from "./ids";
import { buildEmailObject, loadAttachmentsByMessage, resolveHeaderProperty } from "./email-objects";
import { importFlags, parseReceivedAt, resolveDraftsMailbox } from "./email-import-utils";
import { filterToSql, mailboxRefCondition, sortToSql } from "./email-query";
import { getEmailState } from "./state";
import { listAccessibleMailboxIdSet, listJmapMailboxes } from "./access";
import { deleteUpload, readUpload, storeRawDraftMime } from "./blobs";
import type { Comparator, EmailAddressObject, Filter, JmapContext, JmapMethodHandler, JmapSetError, MailboxRef } from "./types";
import type { AttachmentContent } from "@/lib/email/attachment-types";

type MessageRow = typeof messages.$inferSelect;

/** The columns a draft row is made of, shared by `Email/set` create and `Email/import`. */
type DraftRow = {
	mailboxId: string;
	fromAddr: string;
	toAddr: string;
	ccAddr: string | null;
	bccAddr: string | null;
	subject: string | null;
	textBody: string | null;
	htmlBody: string | null;
	inReplyTo: string | null;
	references: string | null;
	read?: boolean;
	starred?: boolean;
	threadId?: string | null;
	providerMessageId?: string | null;
	rawR2Key?: string | null;
	createdAt?: Date;
};

/** Insert a draft and return its id. Drafts are outbound mail that has not been sent. */
async function insertDraft(ctx: JmapContext, row: DraftRow): Promise<string> {
	const id = newId("msg");
	await ctx.db.insert(messages).values({
		id,
		userId: ctx.auth.userId,
		mailboxId: row.mailboxId,
		direction: "outbound",
		fromAddr: row.fromAddr,
		toAddr: row.toAddr,
		ccAddr: row.ccAddr,
		bccAddr: row.bccAddr,
		subject: row.subject,
		snippet: buildSnippet(row.textBody, row.htmlBody),
		textBody: row.textBody,
		htmlBody: row.htmlBody,
		status: "draft",
		read: row.read ?? true,
		starred: row.starred ?? false,
		inReplyTo: row.inReplyTo,
		references: row.references,
		threadId: row.threadId ?? null,
		providerMessageId: row.providerMessageId ?? null,
		rawR2Key: row.rawR2Key ?? null,
		...(row.createdAt ? { createdAt: row.createdAt } : {}),
	});
	return id;
}

async function scope(ctx: JmapContext) {
	const ids = Array.from(await listAccessibleMailboxIdSet(ctx));
	return { ids, condition: ids.length ? inArray(messages.mailboxId, ids) : ctx.auth.mailboxIds ? sql`1 = 0` : eq(messages.userId, ctx.auth.userId) };
}

export async function loadMessages(ctx: JmapContext, ids: string[]): Promise<MessageRow[]> {
	if (ids.length === 0) return [];
	const { ids: accessible, condition } = await scope(ctx);
	// D1 caps bound parameters per query at 100, and the scope predicate
	// already binds the accessible mailbox ids, so the remainder is the id
	// batch size. Callers key rows by id, so dedupe first: an id split over
	// two batches would otherwise return its row twice.
	const batch = Math.max(1, 100 - accessible.length);
	const unique = [...new Set(ids)];
	const rows: MessageRow[] = [];
	for (let offset = 0; offset < unique.length; offset += batch) {
		rows.push(...(await ctx.db.select().from(messages).where(and(condition, inArray(messages.id, unique.slice(offset, offset + batch))))));
	}
	return rows;
}

export const emailGet: JmapMethodHandler = async (ctx, args) => {
	const ids = args.ids as string[] | null | undefined;
	if (!ids) throw new JmapError("requestTooLarge", "Email/get needs an explicit list of ids");
	if (ids.length > LIMITS.maxObjectsInGet) throw new JmapError("requestTooLarge");
	const properties = args.properties as string[] | null | undefined;
	const fetchBodies = !!(args.fetchTextBodyValues || args.fetchHTMLBodyValues || args.fetchAllBodyValues);
	const maxBodyValueBytes = Number(args.maxBodyValueBytes ?? 0);

	const rows = await loadMessages(ctx, ids);
	const attachments = await loadAttachmentsByMessage(ctx, rows.map((row) => row.id));
	const found = new Set<string>();
	const list = rows.map((row) => {
		found.add(row.id);
		const full = buildEmailObject(row, attachments.get(row.id) ?? [], { fetchBodies, maxBodyValueBytes });
		if (!properties) return full;
		const picked: Record<string, unknown> = { id: row.id };
		for (const key of properties) {
			if (key.startsWith("header:")) picked[key] = resolveHeaderProperty(row, key);
			else if (key in full) picked[key] = (full as Record<string, unknown>)[key];
		}
		return picked;
	});
	return { accountId: ctx.accountId, state: await getEmailState(ctx), list, notFound: ids.filter((id) => !found.has(id)) };
};

export const emailQuery: JmapMethodHandler = async (ctx, args) => {
	const { ids: accessibleIds, condition } = await scope(ctx);
	const filter = filterToSql(args.filter as Filter | null | undefined, new Set(accessibleIds));
	const where = filter ? and(condition, filter) : condition;
	const order = sortToSql(args.sort as Comparator[] | null | undefined);
	const collapse = !!args.collapseThreads;
	const limit = Math.min(Math.max(Number(args.limit ?? LIMITS.maxQueryLimit), 0), LIMITS.maxQueryLimit);
	let position = Number(args.position ?? 0);

	// Anchors are resolved by materialising the ordered id list up to a bound;
	// mailboxes here are small enough that this stays cheap.
	const threadKey = sql<string>`coalesce(${messages.threadId}, ${messages.id})`;
	const allRows = await ctx.db
		.select({ id: messages.id, thread: threadKey })
		.from(messages)
		.where(where)
		.orderBy(...order)
		.limit(10_000);
	let ordered = allRows.map((row) => row.id);
	if (collapse) {
		const seen = new Set<string>();
		ordered = allRows.filter((row) => (seen.has(row.thread) ? false : (seen.add(row.thread), true))).map((row) => row.id);
	}
	if (args.anchor) {
		const index = ordered.indexOf(String(args.anchor));
		if (index < 0) return { type: "anchorNotFound" };
		position = index + Number(args.anchorOffset ?? 0);
	}
	if (position < 0) position = Math.max(ordered.length + position, 0);
	const page = ordered.slice(position, position + limit);

	return {
		accountId: ctx.accountId,
		queryState: await getEmailState(ctx),
		canCalculateChanges: false,
		position,
		ids: page,
		...(args.calculateTotal ? { total: ordered.length } : {}),
	};
};

export const emailChanges: JmapMethodHandler = async (ctx, args) => emailChangesSince(ctx, args);

export const emailQueryChanges: JmapMethodHandler = async () => {
	return { type: "cannotCalculateChanges" };
};

/** Where a patched `mailboxIds` puts the message: exactly one JMAP mailbox is supported. */
function targetFromMailboxIds(row: MessageRow, patch: Record<string, unknown>, accessible: Set<string>): { status?: string; folderId?: string | null } | { error: Record<string, unknown> } | null {
	let ids: string[] | null = null;
	if (patch.mailboxIds && typeof patch.mailboxIds === "object") {
		ids = Object.entries(patch.mailboxIds as Record<string, boolean>).filter(([, on]) => on).map(([id]) => id);
	} else {
		const current = new Set(Object.keys(buildEmailObject(row, [], { fetchBodies: false, maxBodyValueBytes: 0 }).mailboxIds));
		let touched = false;
		for (const [key, value] of Object.entries(patch)) {
			if (!key.startsWith("mailboxIds/")) continue;
			touched = true;
			const id = key.slice("mailboxIds/".length);
			if (value) current.add(id);
			else current.delete(id);
		}
		if (touched) ids = Array.from(current);
	}
	if (!ids) return null;
	if (ids.length !== 1) return { error: { type: "invalidProperties", properties: ["mailboxIds"], description: "A message belongs to exactly one mailbox" } };
	const ref: MailboxRef | null = decodeMailboxRef(ids[0]);
	if (!ref || !accessible.has(ref.mailboxId)) return { error: { type: "invalidProperties", properties: ["mailboxIds"], description: "Unknown mailbox" } };
	if (ref.mailboxId !== row.mailboxId) return { error: { type: "invalidProperties", properties: ["mailboxIds"], description: "Messages cannot move between accounts' mailboxes" } };
	if (ref.kind === "account") return { error: { type: "invalidProperties", properties: ["mailboxIds"], description: "Choose a folder or system mailbox" } };
	if (ref.kind === "folder") return { status: row.direction === "outbound" && row.status !== "draft" ? "sent" : "received", folderId: ref.folderId };
	if (ref.role === "sent" && row.direction === "inbound") return { error: { type: "invalidProperties", properties: ["mailboxIds"], description: "Received mail cannot be moved to Sent" } };
	return { status: roleToStatus(ref.role), folderId: null };
}

function keywordsFromPatch(patch: Record<string, unknown>): { read?: boolean; starred?: boolean } {
	const result: { read?: boolean; starred?: boolean } = {};
	const apply = (keyword: string, value: unknown) => {
		if (keyword === KEYWORD_SEEN) result.read = !!value;
		if (keyword === KEYWORD_FLAGGED) result.starred = !!value;
	};
	if (patch.keywords && typeof patch.keywords === "object") {
		const map = patch.keywords as Record<string, boolean>;
		result.read = !!map[KEYWORD_SEEN];
		result.starred = !!map[KEYWORD_FLAGGED];
	}
	for (const [key, value] of Object.entries(patch)) {
		if (key.startsWith("keywords/")) apply(key.slice("keywords/".length), value);
	}
	return result;
}

/** Drafts are the only thing a client creates; everything else is a flag or a move. */
async function createDraft(ctx: JmapContext, value: Record<string, unknown>, accessible: Set<string>) {
	const target = resolveDraftsMailbox(value.mailboxIds, accessible);
	if ("error" in target) return target;
	const from = (value.from as EmailAddressObject[] | undefined)?.[0]?.email;
	if (!from) return { error: { type: "invalidProperties", properties: ["from"] } };
	let sender: { fromAddr: string; mailboxId: string };
	try {
		sender = await getAuthorizedSenderAddress(ctx.env, { userId: ctx.auth.userId, from, mailboxId: target.mailboxId });
	} catch (error) {
		return { error: { type: "forbidden", description: error instanceof Error ? error.message : "Cannot send from that address" } };
	}
	const addressList = (list: unknown) =>
		Array.isArray(list) ? joinEmailAddressList((list as EmailAddressObject[]).map((item) => (item.name ? `"${item.name.replace(/"/g, '\\"')}" <${item.email}>` : item.email))) : "";
	const bodyValues = (value.bodyValues ?? {}) as Record<string, { value: string }>;
	const partText = (parts: unknown) => (Array.isArray(parts) && parts[0]?.partId ? bodyValues[parts[0].partId]?.value ?? "" : "");
	const text = partText(value.textBody);
	const html = partText(value.htmlBody);
	const references = Array.isArray(value.references) ? (value.references as string[]).join(" ") : null;

	const id = await insertDraft(ctx, {
		mailboxId: sender.mailboxId,
		fromAddr: sender.fromAddr,
		toAddr: addressList(value.to),
		ccAddr: addressList(value.cc) || null,
		bccAddr: addressList(value.bcc) || null,
		subject: typeof value.subject === "string" ? value.subject : null,
		textBody: text || null,
		htmlBody: html || null,
		inReplyTo: Array.isArray(value.inReplyTo) ? (value.inReplyTo as string[])[0] ?? null : null,
		references,
	});

	const uploads: AttachmentContent[] = [];
	for (const part of (value.attachments as Array<{ blobId?: string; name?: string; type?: string; disposition?: string; cid?: string }> | undefined) ?? []) {
		const blob = part.blobId ? decodeBlobId(part.blobId) : null;
		if (!blob || blob.kind !== "up") continue;
		const upload = await readUpload(ctx, blob.id);
		if (!upload) continue;
		uploads.push({ filename: part.name ?? upload.name ?? "attachment", type: part.type ?? upload.type, content: upload.content, disposition: part.disposition === "inline" ? ("inline" as const) : ("attachment" as const), contentId: part.cid ?? null });
	}
	if (uploads.length) {
		try {
			await storeMessageAttachments(ctx.env, id, uploads);
		} catch (error) {
			await ctx.db.delete(messages).where(eq(messages.id, id));
			return { error: { type: "tooLarge", description: error instanceof Error ? error.message : "Attachments rejected" } };
		}
	}
	return { id };
}

export const emailSet: JmapMethodHandler = async (ctx, args) => {
	const oldState = await getEmailState(ctx);
	if (args.ifInState && args.ifInState !== oldState) return { type: "stateMismatch" };
	const accessible = await listAccessibleMailboxIdSet(ctx);
	const writable = new Set((await listJmapMailboxes(ctx)).filter((row) => row.permission !== "read_only").map((row) => row.id));
	const created: Record<string, unknown> = {};
	const notCreated: Record<string, unknown> = {};
	const updated: Record<string, null> = {};
	const notUpdated: Record<string, unknown> = {};
	const destroyed: string[] = [];
	const notDestroyed: Record<string, unknown> = {};

	for (const [creationId, value] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
		const result = await createDraft(ctx, value, writable);
		if ("error" in result) {
			notCreated[creationId] = result.error;
			continue;
		}
		ctx.createdIds[creationId] = result.id;
		const [row] = await loadMessages(ctx, [result.id]);
		created[creationId] = row ? buildEmailObject(row, [], { fetchBodies: false, maxBodyValueBytes: 0 }) : { id: result.id };
	}

	const updates = Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>);
	const rows = await loadMessages(ctx, updates.map(([id]) => id));
	const byId = new Map(rows.map((row) => [row.id, row]));
	for (const [id, patch] of updates) {
		const row = byId.get(id);
		if (!row || !row.mailboxId) {
			notUpdated[id] = { type: "notFound" };
			continue;
		}
		if (!writable.has(row.mailboxId)) {
			notUpdated[id] = { type: "forbidden" };
			continue;
		}
		const move = targetFromMailboxIds(row, patch, accessible);
		if (move && "error" in move) {
			notUpdated[id] = move.error;
			continue;
		}
		const flags = keywordsFromPatch(patch);
		const set: Partial<MessageRow> = {};
		if (flags.read !== undefined) set.read = flags.read;
		if (flags.starred !== undefined) set.starred = flags.starred;
		if (move) {
			if (move.status !== undefined) set.status = move.status;
			if (move.folderId !== undefined) set.folderId = move.folderId;
		}
		if (Object.keys(set).length) await ctx.db.update(messages).set(set).where(eq(messages.id, id));
		updated[id] = null;
	}

	// JMAP destroy is permanent; Mailflare keeps a trash, so destroy moves there
	// and a second destroy from Trash deletes the row.
	const destroyIds = (args.destroy ?? []) as string[];
	const destroyRows = await loadMessages(ctx, destroyIds);
	const destroyById = new Map(destroyRows.map((row) => [row.id, row]));
	for (const id of destroyIds) {
		const row = destroyById.get(id);
		if (!row || !row.mailboxId) {
			notDestroyed[id] = { type: "notFound" };
			continue;
		}
		if (!writable.has(row.mailboxId)) {
			notDestroyed[id] = { type: "forbidden" };
			continue;
		}
		if (row.status === "trash" || row.status === "draft") await deleteMessageWithObjects(ctx.env, ctx.db, row.id, row.rawR2Key);
		else await ctx.db.update(messages).set({ status: "trash", folderId: null }).where(eq(messages.id, id));
		destroyed.push(id);
	}

	return { accountId: ctx.accountId, oldState, newState: await getEmailState(ctx), created, updated, destroyed, notCreated, notUpdated, notDestroyed };
};

/**
 * Import one uploaded `message/rfc822` blob as a draft (RFC 8621 §4.8). Clients
 * that compose MIME locally send by uploading it, importing it into Drafts and
 * then submitting it, so this is the first half of their send path. The raw
 * bytes are kept verbatim under `drafts/` and the parsed headers fill the
 * columns the rest of Mailflare reads, including `providerMessageId`, which is
 * what lets a client find its own draft again with a Message-ID header filter.
 */
async function importEmail(ctx: JmapContext, value: Record<string, unknown>, writable: Set<string>): Promise<{ id: string } | { error: JmapSetError }> {
	const target = resolveDraftsMailbox(value.mailboxIds, writable);
	if ("error" in target) return target;

	const blob = typeof value.blobId === "string" ? decodeBlobId(value.blobId) : null;
	if (!blob || blob.kind !== "up") return { error: { type: "blobNotFound", description: "blobId must name an upload from this account" } };
	const upload = await readUpload(ctx, blob.id);
	if (!upload) return { error: { type: "blobNotFound", description: "No such upload" } };
	if (upload.content.byteLength === 0) return { error: { type: "invalidEmail", description: "The blob is empty" } };
	if (upload.content.byteLength > LIMITS.maxSizeUpload) return { error: { type: "tooLarge", description: "The message exceeds maxSizeUpload" } };

	let parsed: Awaited<ReturnType<typeof parseRawMime>>;
	try {
		parsed = await parseRawMime(upload.content);
	} catch (error) {
		return { error: { type: "invalidEmail", description: error instanceof Error ? error.message : "The blob is not a MIME message" } };
	}
	if (!parsed.fromAddr) return { error: { type: "invalidEmail", description: "The message has no From header" } };

	let sender: { fromAddr: string; mailboxId: string };
	try {
		sender = await getAuthorizedSenderAddress(ctx.env, { userId: ctx.auth.userId, from: parsed.fromAddr, mailboxId: target.mailboxId });
	} catch (error) {
		return { error: { type: "forbidden", description: error instanceof Error ? error.message : "Cannot send from that address" } };
	}

	const flags = importFlags(value.keywords);
	const id = await insertDraft(ctx, {
		mailboxId: sender.mailboxId,
		fromAddr: sender.fromAddr,
		toAddr: parsed.toAddr ?? "",
		ccAddr: parsed.ccAddr,
		bccAddr: parsed.bccAddr,
		subject: parsed.subject,
		textBody: parsed.text,
		htmlBody: parsed.html,
		inReplyTo: parsed.inReplyTo,
		references: parsed.references.length ? parsed.references.join(" ") : null,
		read: flags.read,
		starred: flags.starred,
		// Angle brackets are kept, as inbound rows store them.
		providerMessageId: parsed.messageId,
		threadId: await resolveThreadId(ctx.db, {
			mailboxId: sender.mailboxId,
			messageId: parsed.messageId,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references,
		}),
		createdAt: parseReceivedAt(value.receivedAt) ?? parsed.date ?? new Date(),
	});

	// Nothing may be left half-imported, so the row and the bytes go together.
	let rawR2Key: string | null = null;
	try {
		rawR2Key = await storeRawDraftMime(ctx, id, upload.content);
		await ctx.db.update(messages).set({ rawR2Key }).where(eq(messages.id, id));
		if (parsed.attachments.length) await storeMessageAttachments(ctx.env, id, parsed.attachments);
	} catch (error) {
		try {
			await deleteMessageWithObjects(ctx.env, ctx.db, id, rawR2Key);
		} catch (cleanupError) {
			console.error(`Failed to clean up rejected Email/import draft ${id}`, cleanupError);
		}
		return { error: { type: "tooLarge", description: error instanceof Error ? error.message : "Attachments rejected" } };
	}
	// The bytes belong to the message now, so release the upload.
	try {
		await deleteUpload(ctx, blob.id);
	} catch (error) {
		// The import is already complete. Failing it here would make a client retry
		// and create a duplicate draft merely because temporary cleanup failed.
		console.warn(`Failed to delete claimed JMAP upload ${blob.id}`, error);
	}
	return { id };
}

export const emailImport: JmapMethodHandler = async (ctx, args) => {
	const oldState = await getEmailState(ctx);
	if (args.ifInState && args.ifInState !== oldState) return { type: "stateMismatch" };
	const emails = (args.emails ?? {}) as Record<string, Record<string, unknown>>;
	if (Object.keys(emails).length > LIMITS.maxObjectsInSet) throw new JmapError("requestTooLarge");
	const writable = new Set((await listJmapMailboxes(ctx)).filter((row) => row.permission !== "read_only").map((row) => row.id));
	const created: Record<string, unknown> = {};
	const notCreated: Record<string, unknown> = {};

	for (const [creationId, value] of Object.entries(emails)) {
		const result = await importEmail(ctx, value ?? {}, writable);
		if ("error" in result) {
			notCreated[creationId] = result.error;
			continue;
		}
		ctx.createdIds[creationId] = result.id;
		const [row] = await loadMessages(ctx, [result.id]);
		if (!row) {
			notCreated[creationId] = { type: "serverFail", description: "The imported message could not be read back" };
			continue;
		}
		// The same values Email/get would answer, so the client can act on them straight away.
		const object = buildEmailObject(row, (await loadAttachmentsByMessage(ctx, [row.id])).get(row.id) ?? [], { fetchBodies: false, maxBodyValueBytes: 0 });
		created[creationId] = { id: object.id, blobId: object.blobId, threadId: object.threadId, size: object.size };
	}

	return { accountId: ctx.accountId, oldState, newState: await getEmailState(ctx), created, notCreated };
};

export const emailUnsupported = (method: string): JmapMethodHandler => async () => ({ type: "unknownMethod", description: `${method} is not supported` });

/** Thread/get: every message sharing a thread key, oldest first. */
export const threadGet: JmapMethodHandler = async (ctx, args) => {
	const ids = args.ids as string[] | null | undefined;
	if (!ids) throw new JmapError("requestTooLarge", "Thread/get needs an explicit list of ids");
	const { ids: accessible, condition } = await scope(ctx);
	const threadKey = sql<string>`coalesce(${messages.threadId}, ${messages.id})`;
	// Same D1 bound-parameter budget as loadMessages; dedupe so a repeated
	// thread id cannot list its messages twice within one group.
	const batch = Math.max(1, 100 - accessible.length);
	const unique = [...new Set(ids)];
	const rows: { id: string; thread: string }[] = [];
	for (let offset = 0; offset < unique.length; offset += batch) {
		rows.push(
			...(await ctx.db
				.select({ id: messages.id, thread: threadKey })
				.from(messages)
				.where(and(condition, inArray(threadKey, unique.slice(offset, offset + batch))))
				.orderBy(asc(messages.createdAt)))
		);
	}
	const grouped = new Map<string, string[]>();
	for (const row of rows) grouped.set(row.thread, [...(grouped.get(row.thread) ?? []), row.id]);
	return {
		accountId: ctx.accountId,
		state: await getEmailState(ctx),
		list: Array.from(grouped, ([id, emailIds]) => ({ id, emailIds })),
		notFound: ids.filter((id) => !grouped.has(id)),
	};
};

export const threadChanges: JmapMethodHandler = async (ctx, args) => threadChangesSince(ctx, args);

/** SearchSnippet/get: the subject and a body excerpt around the first match, with <mark> tags. */
export const searchSnippetGet: JmapMethodHandler = async (ctx, args) => {
	const ids = (args.emailIds as string[]) ?? [];
	const filter = (args.filter ?? {}) as { text?: string; subject?: string; body?: string };
	const term = (filter.text ?? filter.body ?? filter.subject ?? "").trim();
	const rows = await loadMessages(ctx, ids);
	const found = new Set<string>();
	const escape = (value: string) => value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!);
	const highlight = (value: string | null) => {
		if (!value) return null;
		if (!term) return escape(value);
		const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
		return escape(value).replace(re, (match) => `<mark>${match}</mark>`);
	};
	const list = rows.map((row) => {
		found.add(row.id);
		const body = row.textBody ?? row.snippet ?? "";
		let excerpt: string | null = null;
		if (term) {
			const index = body.toLowerCase().indexOf(term.toLowerCase());
			if (index >= 0) excerpt = highlight(body.slice(Math.max(index - 80, 0), index + 160));
		}
		return { emailId: row.id, subject: highlight(row.subject), preview: excerpt };
	});
	return { accountId: ctx.accountId, list, notFound: ids.filter((id) => !found.has(id)) };
};

export { count, desc, mailboxRefCondition, invalidArguments };
