import { and, eq, inArray, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, calendarShares, davCollections, driveItems, mailboxes, messageAttachments, messages, sessions, users } from "@/db/schema";
import { canManageUsers, isPrimaryAdmin } from "@/lib/auth/admin";
import type { SessionUser } from "@/lib/auth/types";
import { deleteDriveItems } from "@/lib/drive/access";
import { driveObjectKey } from "@/lib/drive/utils";
import { newId } from "@/lib/ids";
import { getAccountSeatError } from "@/lib/licenses/seats";
import { removeMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import { avatarKeyFor } from "@/app/api/profile/avatar/utils";
import { getAccountPurgeCutoff } from "./deletion-utils";
import type { DeleteAccountsInput, DeleteAccountsResult } from "./deletion-types";
import { transferCalendars } from "@/lib/calendar/calendars";
import { roomsBookable } from "@/lib/calendar/room-licence";
import { declineBookingsOfStatement, rebookWaiting } from "@/lib/calendar/room-save";
import { deleteUnreferencedObjects } from "@/lib/drive/shared-objects";

const CHUNK = 50;

function chunks<T>(items: T[], size = CHUNK): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
	return out;
}

/**
 * Moves Drive files (documents included), calendars and their events from one account to another. Drive items that sat at
 * the top level go into a folder on the receiving account so they do not mix with its own files.
 */
export async function transferAccountData(env: CloudflareEnv, fromId: string, fromName: string, toId: string): Promise<void> {
	const db = getDb(env);
	const items = await db.select().from(driveItems).where(eq(driveItems.ownerId, fromId));
	if (items.length) {
		// Stored objects are keyed by owner unless the row records its key, so pin the key before the owner changes.
		for (const row of items) {
			if (row.kind === "file" && !row.r2Key) await db.update(driveItems).set({ r2Key: driveObjectKey(fromId, row.id) }).where(eq(driveItems.id, row.id));
		}
		const folderId = newId();
		await db.insert(driveItems).values({ id: folderId, ownerId: toId, parentId: null, kind: "folder", name: `Files from ${fromName}`.slice(0, 255) });
		const rootIds = items.filter((row) => !row.parentId).map((row) => row.id);
		for (const ids of chunks(rootIds)) await db.update(driveItems).set({ parentId: folderId }).where(inArray(driveItems.id, ids));
		await db.update(driveItems).set({ ownerId: toId }).where(and(eq(driveItems.ownerId, fromId), isNull(driveItems.uploadId)));
	}
	// Extra calendars change owner first, so their events (moved next) are never owned by someone other than their calendar.
	await transferCalendars(db, fromId, toId);
	// The events move to another owner. Those with no zone of their own (an all-day event, or a repeating one) are read in their owner's zone, so they may
	// now happen at another time: their accepted bookings are declined in the same batch by one statement that selects them itself, first, and about 20 are
	// checked again here (the rest wait declined, which fails closed).
	const moving = db.select({ id: calendarEvents.id }).from(calendarEvents).where(and(eq(calendarEvents.userId, fromId), isNull(calendarEvents.timeZone), or(eq(calendarEvents.allDay, true), ne(calendarEvents.repeat, "none"))));
	// Always the same two statements, whether or not the account has rooms: nothing is read first, so a booking made at any moment is covered. As one batch
	// they are all-or-nothing. A drizzle handle with no batch client (a proxy built without one, as in a test) throws a TypeError before running anything; then
	// the same two statements run in the same order, the decline first, which on its own fails closed if it stops in between. A database error is not a TypeError
	// and is never retried.
	const decline = declineBookingsOfStatement(db, moving);
	const move = db.update(calendarEvents).set({ userId: toId }).where(eq(calendarEvents.userId, fromId));
	try { await db.batch([decline, move] as never); } catch (error) {
		if (!(error instanceof TypeError)) throw error;
		await decline;
		await move;
	}
	await rebookWaiting(db, toId, roomsBookable(env));
}

/**
 * A deleted account takes its sharing with it: grants it holds, and grants on the calendars it still owns (the extra
 * calendars it handed to another account are not its any more, so their grants stay). Explicit statements, not just the
 * foreign-key cascade the purge relies on, so the people it shared with lose access when the account is deleted, not 30 days later.
 */
async function removeCalendarShares(db: ReturnType<typeof getDb>, userIds: string[]): Promise<void> {
	for (const group of chunks(userIds)) {
		await db.delete(calendarShares).where(inArray(calendarShares.granteeUserId, group));
		const owned = (await db.select({ id: davCollections.id }).from(davCollections).where(inArray(davCollections.userId, group))).map((row) => row.id);
		for (const calendars of chunks(owned)) await db.delete(calendarShares).where(inArray(calendarShares.calendarId, calendars));
	}
}

/**
 * Soft-deletes accounts: they are disabled, signed out and stamped with `deletedAt`. They can be restored until the
 * scheduled purge removes them after the retention window. Optionally hands their Drive and calendar data to another account.
 */
export async function deleteAccounts(env: CloudflareEnv, actor: SessionUser, input: DeleteAccountsInput): Promise<DeleteAccountsResult> {
	if (!canManageUsers(actor)) return { ok: false, status: 403, error: "You do not have permission to manage users" };
	const ids = [...new Set(input.ids)];
	if (!ids.length) return { ok: false, status: 400, error: "Select at least one account" };
	const db = getDb(env);
	const targets: (typeof users.$inferSelect)[] = [];
	for (const group of chunks(ids)) targets.push(...(await db.select().from(users).where(inArray(users.id, group))));
	if (targets.length !== ids.length) return { ok: false, status: 404, error: "Account not found" };
	for (const target of targets) {
		if (target.id === actor.id) return { ok: false, status: 400, error: "You cannot delete your own account" };
		if (target.isPrimaryAdmin) return { ok: false, status: 403, error: "The primary admin cannot be deleted" };
		if (!isPrimaryAdmin(actor) && target.role === "admin") return { ok: false, status: 403, error: "Only the primary admin can manage admin accounts" };
		if (target.deletedAt) return { ok: false, status: 409, error: `${target.email} is already deleted` };
	}
	const transferToId = input.transferToId || null;
	if (transferToId) {
		const [recipient] = await db.select().from(users).where(eq(users.id, transferToId)).limit(1);
		if (!recipient || recipient.disabled || recipient.deletedAt || ids.includes(recipient.id)) {
			return { ok: false, status: 400, error: "Choose an active account to transfer data to" };
		}
		if (!isPrimaryAdmin(actor) && recipient.role === "admin" && recipient.id !== actor.id) {
			return { ok: false, status: 403, error: "Only the primary admin can transfer data to an admin account" };
		}
		for (const target of targets) await transferAccountData(env, target.id, target.name || target.email, recipient.id);
	}
	await removeCalendarShares(db, ids);
	const now = new Date();
	for (const group of chunks(ids)) {
		await db.update(users).set({ deletedAt: now, disabled: true }).where(inArray(users.id, group));
		await db.delete(sessions).where(inArray(sessions.userId, group));
	}
	return { ok: true, deleted: ids.length };
}

export async function restoreAccount(env: CloudflareEnv, actor: SessionUser, id: string): Promise<DeleteAccountsResult> {
	if (!canManageUsers(actor)) return { ok: false, status: 403, error: "You do not have permission to manage users" };
	const db = getDb(env);
	const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
	if (!target) return { ok: false, status: 404, error: "Account not found" };
	if (!target.deletedAt) return { ok: false, status: 409, error: "Account is not deleted" };
	if (!isPrimaryAdmin(actor) && target.role === "admin") return { ok: false, status: 403, error: "Only the primary admin can manage admin accounts" };
	const seatError = await getAccountSeatError(env);
	if (seatError) return { ok: false, status: 403, error: seatError };
	await db.update(users).set({ deletedAt: null, disabled: false }).where(eq(users.id, id));
	return { ok: true, deleted: 0 };
}

async function purgeAccount(env: CloudflareEnv, account: typeof users.$inferSelect): Promise<void> {
	const db = getDb(env);
	const owned = await db.select().from(mailboxes).where(eq(mailboxes.userId, account.id));
	for (const mailbox of owned) {
		try {
			await removeMailboxDomainRouting(env, db, mailbox);
		} catch (error) {
			console.error("Account purge: could not remove routing", { mailboxId: mailbox.id, error });
		}
	}
	const rootItems = await db.select().from(driveItems).where(and(eq(driveItems.ownerId, account.id), isNull(driveItems.parentId)));
	if (rootItems.length) await deleteDriveItems(env, rootItems);
	for (const mailbox of owned) {
		const raw = await db.select({ key: messages.rawR2Key }).from(messages).where(and(eq(messages.mailboxId, mailbox.id), isNotNull(messages.rawR2Key)));
		const attachments = await db.select({ id: messageAttachments.id, key: messageAttachments.r2Key }).from(messageAttachments).innerJoin(messages, eq(messages.id, messageAttachments.messageId)).where(eq(messages.mailboxId, mailbox.id));
		const rawKeys = raw.map((row) => row.key).filter((key): key is string => !!key);
		for (const group of chunks(rawKeys, 500)) await env.BUCKET.delete(group);
		// Another user's Drive item may share an attachment object.
		await deleteUnreferencedObjects(env, db, attachments.map((row) => row.key), { attachmentIds: attachments.map((row) => row.id) });
	}
	await env.BUCKET.delete(account.avatarKey ?? avatarKeyFor(account.id));
	await db.delete(users).where(eq(users.id, account.id));
}

/** Removes accounts whose restore window has ended, with their data. Runs from the daily scheduled handler. */
export async function runAccountRetention(env: CloudflareEnv, now = new Date()): Promise<number> {
	const db = getDb(env);
	const expired = await db.select().from(users).where(and(isNotNull(users.deletedAt), lte(users.deletedAt, getAccountPurgeCutoff(now)))).limit(20);
	let removed = 0;
	for (const account of expired) {
		try {
			await purgeAccount(env, account);
			removed += 1;
		} catch (error) {
			console.error("Account purge failed", { userId: account.id, error });
		}
	}
	return removed;
}
