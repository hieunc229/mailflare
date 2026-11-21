import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { mailboxChangesSince } from "./changes";
import { folders, messages } from "@/db/schema";
import { draftsVisibleTo } from "@/lib/email/draft-access";
import { newId } from "@/lib/ids";
import { JmapError } from "./errors";
import { decodeMailboxRef, encodeMailboxRef, roleToStatus, SYSTEM_ROLES } from "./ids";
import { getMailboxState } from "./state";
import type { AccessibleMailbox, JmapContext, JmapMethodHandler, SystemRole } from "./types";
import { listFoldersByMailbox, listJmapMailboxes } from "./access";

const ROLE_NAMES: Record<SystemRole, string> = {
	inbox: "Inbox",
	sent: "Sent",
	drafts: "Drafts",
	archive: "Archive",
	junk: "Spam",
	trash: "Trash",
};
const ROLE_ORDER: Record<SystemRole, number> = { inbox: 1, drafts: 2, sent: 3, archive: 4, junk: 5, trash: 6 };

type Counts = { total: number; unread: number };

/**
 * Per-mailbox tallies in one pass: rows grouped by (mailbox, status, folder)
 * are folded into the JMAP Mailbox each combination belongs to.
 */
async function loadCounts(ctx: JmapContext, mailboxIds: string[]): Promise<Map<string, Counts>> {
	const result = new Map<string, Counts>();
	if (mailboxIds.length === 0) return result;
	const rows = await ctx.db
		.select({
			mailboxId: messages.mailboxId,
			status: messages.status,
			folderId: messages.folderId,
			total: count(),
			unread: sql<number>`sum(case when not ${messages.read} and ${messages.direction} = 'inbound' then 1 else 0 end)`,
		})
		.from(messages)
		.where(and(inArray(messages.mailboxId, mailboxIds), draftsVisibleTo(ctx.auth.userId)))
		.groupBy(messages.mailboxId, messages.status, messages.folderId);

	const add = (key: string, row: { total: number; unread: number }) => {
		const current = result.get(key) ?? { total: 0, unread: 0 };
		result.set(key, { total: current.total + row.total, unread: current.unread + Number(row.unread ?? 0) });
	};
	for (const row of rows) {
		if (!row.mailboxId) continue;
		add(encodeMailboxRef({ kind: "account", mailboxId: row.mailboxId }), row);
		if (row.folderId) {
			add(encodeMailboxRef({ kind: "folder", mailboxId: row.mailboxId, folderId: row.folderId }), row);
			continue;
		}
		const role = statusRole(row.status);
		if (role) add(encodeMailboxRef({ kind: "role", mailboxId: row.mailboxId, role }), row);
	}
	return result;
}

function statusRole(status: string): SystemRole | null {
	for (const role of SYSTEM_ROLES) if (roleToStatus(role) === status) return role;
	if (status === "queued" || status === "failed") return "sent";
	return null;
}

function rights(mailbox: AccessibleMailbox, system: boolean) {
	const canWrite = mailbox.permission !== "read_only";
	const canSend = mailbox.permission === "send_as" || mailbox.permission === "send_on_behalf" || mailbox.permission === "full_access";
	return {
		mayReadItems: true,
		mayAddItems: canWrite,
		mayRemoveItems: canWrite,
		maySetSeen: canWrite,
		maySetKeywords: canWrite,
		mayCreateChild: mailbox.permission === "full_access",
		mayRename: !system && mailbox.permission === "full_access",
		mayDelete: !system && mailbox.permission === "full_access",
		maySubmit: canSend,
	};
}

/** Every Mailbox object visible to the account. */
export async function buildAllMailboxes(ctx: JmapContext) {
	const accessible = await listJmapMailboxes(ctx);
	const ids = accessible.map((row) => row.id);
	const [foldersByMailbox, counts] = await Promise.all([listFoldersByMailbox(ctx, ids), loadCounts(ctx, ids)]);
	const list: Array<Record<string, unknown>> = [];
	let sortBase = 0;

	for (const mailbox of accessible) {
		const address = `${mailbox.localPart}@${mailbox.hostname}`;
		const accountId = encodeMailboxRef({ kind: "account", mailboxId: mailbox.id });
		const accountCounts = counts.get(accountId) ?? { total: 0, unread: 0 };
		list.push({
			id: accountId,
			name: mailbox.displayName ? `${mailbox.displayName} <${address}>` : address,
			parentId: null,
			role: null,
			sortOrder: sortBase,
			totalEmails: accountCounts.total,
			unreadEmails: accountCounts.unread,
			totalThreads: accountCounts.total,
			unreadThreads: accountCounts.unread,
			myRights: rights(mailbox, true),
			isSubscribed: true,
		});
		for (const role of SYSTEM_ROLES) {
			const id = encodeMailboxRef({ kind: "role", mailboxId: mailbox.id, role });
			const c = counts.get(id) ?? { total: 0, unread: 0 };
			list.push({
				id,
				name: ROLE_NAMES[role],
				parentId: accountId,
				role,
				sortOrder: sortBase + ROLE_ORDER[role],
				totalEmails: c.total,
				unreadEmails: role === "inbox" ? c.unread : 0,
				totalThreads: c.total,
				unreadThreads: role === "inbox" ? c.unread : 0,
				myRights: rights(mailbox, true),
				isSubscribed: true,
			});
		}
		for (const folder of foldersByMailbox.get(mailbox.id) ?? []) {
			const id = encodeMailboxRef({ kind: "folder", mailboxId: mailbox.id, folderId: folder.id });
			const c = counts.get(id) ?? { total: 0, unread: 0 };
			list.push({
				id,
				name: folder.name,
				parentId: accountId,
				role: null,
				sortOrder: sortBase + 10,
				totalEmails: c.total,
				unreadEmails: c.unread,
				totalThreads: c.total,
				unreadThreads: c.unread,
				myRights: rights(mailbox, false),
				isSubscribed: true,
			});
		}
		sortBase += 100;
	}
	return list;
}

export const mailboxGet: JmapMethodHandler = async (ctx, args) => {
	const all = await buildAllMailboxes(ctx);
	const ids = args.ids as string[] | null | undefined;
	const properties = args.properties as string[] | null | undefined;
	const wanted = ids ? all.filter((item) => ids.includes(item.id as string)) : all;
	const found = new Set(wanted.map((item) => item.id as string));
	return {
		accountId: ctx.accountId,
		state: await getMailboxState(ctx),
		list: wanted.map((item) => pick(item, properties)),
		notFound: ids ? ids.filter((id) => !found.has(id)) : [],
	};
};

export const mailboxQuery: JmapMethodHandler = async (ctx, args) => {
	const all = await buildAllMailboxes(ctx);
	const filter = (args.filter ?? {}) as { parentId?: string | null; name?: string; role?: string | null; hasAnyRole?: boolean };
	let rows = all;
	if (filter.parentId !== undefined) rows = rows.filter((item) => item.parentId === filter.parentId);
	if (filter.name) rows = rows.filter((item) => String(item.name).toLowerCase().includes(filter.name!.toLowerCase()));
	if (filter.role !== undefined) rows = rows.filter((item) => item.role === filter.role);
	if (filter.hasAnyRole !== undefined) rows = rows.filter((item) => (item.role !== null) === filter.hasAnyRole);
	rows = [...rows].sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
	const position = Math.max(Number(args.position ?? 0), 0);
	const limit = args.limit == null ? rows.length : Math.max(Number(args.limit), 0);
	return {
		accountId: ctx.accountId,
		queryState: await getMailboxState(ctx),
		canCalculateChanges: false,
		position,
		ids: rows.slice(position, position + limit).map((item) => item.id),
		total: rows.length,
	};
};

export const mailboxChanges: JmapMethodHandler = async (ctx, args) => mailboxChangesSince(ctx, args);

/** Folders can be created, renamed and removed; system mailboxes cannot. */
export const mailboxSet: JmapMethodHandler = async (ctx, args) => {
	const oldState = await getMailboxState(ctx);
	if (args.ifInState && args.ifInState !== oldState) return { type: "stateMismatch" };
	const accessible = await listJmapMailboxes(ctx);
	const created: Record<string, unknown> = {};
	const notCreated: Record<string, unknown> = {};
	const updated: Record<string, null> = {};
	const notUpdated: Record<string, unknown> = {};
	const destroyed: string[] = [];
	const notDestroyed: Record<string, unknown> = {};

	for (const [creationId, value] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
		const parent = typeof value.parentId === "string" ? decodeMailboxRef(value.parentId) : null;
		const name = typeof value.name === "string" ? value.name.trim() : "";
		const mailbox = parent && accessible.find((row) => row.id === parent.mailboxId);
		if (!parent || parent.kind !== "account" || !mailbox || mailbox.permission !== "full_access") {
			notCreated[creationId] = { type: "invalidProperties", properties: ["parentId"], description: "Folders live directly under a mailbox" };
			continue;
		}
		if (!name || name.length > 80) {
			notCreated[creationId] = { type: "invalidProperties", properties: ["name"] };
			continue;
		}
		const id = newId("fld");
		try {
			await ctx.db.insert(folders).values({ id, userId: mailbox.userId, mailboxId: mailbox.id, name });
		} catch {
			notCreated[creationId] = { type: "invalidProperties", properties: ["name"], description: "A folder with that name already exists" };
			continue;
		}
		const jmapId = encodeMailboxRef({ kind: "folder", mailboxId: mailbox.id, folderId: id });
		ctx.createdIds[creationId] = jmapId;
		created[creationId] = { id: jmapId, role: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true };
	}

	for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
		const ref = decodeMailboxRef(id);
		const mailbox = ref && accessible.find((row) => row.id === ref.mailboxId);
		if (!ref || !mailbox) {
			notUpdated[id] = { type: "notFound" };
			continue;
		}
		const keys = Object.keys(patch).filter((key) => key !== "isSubscribed" && key !== "sortOrder");
		if (ref.kind !== "folder") {
			notUpdated[id] = keys.length ? { type: "forbidden", description: "System mailboxes cannot be changed" } : undefined!;
			if (!keys.length) updated[id] = null;
			continue;
		}
		if (keys.some((key) => key !== "name")) {
			notUpdated[id] = { type: "invalidProperties", properties: keys.filter((key) => key !== "name") };
			continue;
		}
		// Renaming is a manage action, like create and destroy: a read-only or send-only sharee must not rename a shared folder.
		if (keys.length && mailbox.permission !== "full_access") {
			notUpdated[id] = { type: "forbidden" };
			continue;
		}
		if (typeof patch.name === "string" && patch.name.trim()) {
			await ctx.db
				.update(folders)
				.set({ name: patch.name.trim() })
				.where(and(eq(folders.id, ref.folderId), eq(folders.mailboxId, mailbox.id)));
		}
		updated[id] = null;
	}

	for (const id of (args.destroy ?? []) as string[]) {
		const ref = decodeMailboxRef(id);
		const mailbox = ref && accessible.find((row) => row.id === ref.mailboxId);
		if (!ref || !mailbox) {
			notDestroyed[id] = { type: "notFound" };
			continue;
		}
		if (ref.kind !== "folder" || mailbox.permission !== "full_access") {
			notDestroyed[id] = { type: "forbidden" };
			continue;
		}
		// The folder id comes from the client: it must belong to the mailbox the permission was checked on.
		const [folder] = await ctx.db.select({ id: folders.id }).from(folders).where(and(eq(folders.id, ref.folderId), eq(folders.mailboxId, mailbox.id))).limit(1);
		if (!folder) {
			notDestroyed[id] = { type: "notFound" };
			continue;
		}
		if (args.onDestroyRemoveEmails) {
			await ctx.db.update(messages).set({ status: "trash", folderId: null }).where(and(eq(messages.folderId, ref.folderId), eq(messages.mailboxId, mailbox.id)));
		} else {
			const [inUse] = await ctx.db.select({ n: count() }).from(messages).where(and(eq(messages.folderId, ref.folderId), eq(messages.mailboxId, mailbox.id), isNull(messages.snoozedUntil)));
			if ((inUse?.n ?? 0) > 0) {
				notDestroyed[id] = { type: "mailboxHasEmail" };
				continue;
			}
		}
		await ctx.db.delete(folders).where(and(eq(folders.id, ref.folderId), eq(folders.mailboxId, mailbox.id)));
		destroyed.push(id);
	}

	return {
		accountId: ctx.accountId,
		oldState,
		newState: await getMailboxState(ctx),
		created,
		updated,
		destroyed,
		notCreated,
		notUpdated,
		notDestroyed,
	};
};

export function pick(item: Record<string, unknown>, properties: string[] | null | undefined): Record<string, unknown> {
	if (!properties) return item;
	const result: Record<string, unknown> = { id: item.id };
	for (const key of properties) if (key in item) result[key] = item[key];
	return result;
}

export function ensureJmapError(error: unknown): never {
	if (error instanceof JmapError) throw error;
	throw error;
}
