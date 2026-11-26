import { and, asc, eq, inArray, isNotNull, lt, notInArray } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, messages, users } from "@/db/schema";
import { permanentlyDeleteMessages } from "@/lib/email/permanent-delete";
import {
	FOLDER_RETENTION_PROTECTED_STATUSES,
	TRASH_RETENTION_BATCH_SIZE,
	getTrashRetentionCutoff,
	normalizeTrashRetentionDays,
} from "./trash-retention-utils";

const RETENTION_COLUMNS = {
	id: messages.id,
	mailboxId: messages.mailboxId,
	rawR2Key: messages.rawR2Key,
	status: messages.status,
};

/**
 * Permanently delete mail that has outlived its owner's retention rules. Runs from the scheduled handler;
 * each run removes at most TRASH_RETENTION_BATCH_SIZE messages in total, so a big backlog drains over
 * several runs.
 *
 * Two rules feed one budget:
 *
 * 1. The owner's Trash/Spam retention (`users.trashRetentionDays`): messages whose `trashedAt` is older
 *    than the window, exactly as before folder rules existed.
 * 2. Per-folder retention (`folders.retentionDays`): messages still in a folder whose `createdAt` — the
 *    message date — is older than the folder's window, whatever their status. The folder rule is the
 *    opt-in that lets retention reach past Trash and Spam, which is the point: a Newsletters folder can
 *    expire on its own schedule. A folder rule and the Trash rule are additive; either one can purge a
 *    trashed message, whichever window it has outlived first. Days are clamped by the same 1-365
 *    normaliser both rules use, so no rule can mean "keep" or "delete immediately" by accident.
 *
 * A message's folder rule follows its `folderId`: deleting the folder clears `folderId` (ON DELETE SET
 * NULL), so its mail falls back to the owner's Trash/Spam rule. Nothing else needs cleaning up.
 *
 * Failures are logged per owner and per folder and never abort the run, so one bad row cannot stop every
 * other mailbox from draining.
 */
export async function runTrashRetention(env: CloudflareEnv, now = new Date()): Promise<number> {
	const db = getDb(env);
	let budget = TRASH_RETENTION_BATCH_SIZE;
	let deleted = 0;

	const owners = await db
		.select({ id: users.id, days: users.trashRetentionDays })
		.from(users)
		.where(isNotNull(users.trashRetentionDays));

	for (const owner of owners) {
		if (budget <= 0) break;
		const days = normalizeTrashRetentionDays(owner.days);
		if (!days) continue;
		try {
			const expired = await db
				.select(RETENTION_COLUMNS)
				.from(messages)
				.where(and(
					eq(messages.userId, owner.id),
					inArray(messages.status, ["trash", "spam"]),
					lt(messages.trashedAt, getTrashRetentionCutoff(now, days)),
				))
				// Oldest first, so a backlog drains in the order mail arrived in Trash and a capped run is repeatable.
				.orderBy(asc(messages.trashedAt), asc(messages.id))
				.limit(budget);
			if (expired.length === 0) continue;
			deleted += await permanentlyDeleteMessages(env, db, owner.id, expired, "retention");
			budget -= expired.length;
		} catch (error) {
			console.error("Trash retention failed for user", owner.id, error);
		}
	}

	if (budget > 0) deleted += await runFolderRetention(env, db, now, budget);
	return deleted;
}

/**
 * The per-folder pass. Mail is aged by `createdAt` (the message date) rather than `trashedAt`: a folder
 * rule applies to mail that was never in Trash, where `trashedAt` is null, and it means "this folder keeps
 * nothing older than N days", so the message's own age is the honest clock. Trash/Spam retention keeps
 * using `trashedAt`, because there the age that matters is how long it has been thrown away.
 *
 * The owner comes from the folder row (`folders.userId`, the mailbox owner), and messages are matched on
 * that same id, so a folder rule can never reach another account's mail. Drafts and mail still in the
 * sending pipeline are left alone: a folder rule must not destroy unsent work or a queued send.
 */
async function runFolderRetention(
	env: CloudflareEnv,
	db: ReturnType<typeof getDb>,
	now: Date,
	budget: number,
): Promise<number> {
	let deleted = 0;
	let rules: Array<{ id: string; userId: string; days: number | null }>;
	try {
		rules = await db
			.select({ id: folders.id, userId: folders.userId, days: folders.retentionDays })
			.from(folders)
			.where(isNotNull(folders.retentionDays))
			// Stable order so a capped run always drains the same folders first.
			.orderBy(asc(folders.createdAt), asc(folders.id));
	} catch (error) {
		// A database that has not run the folder-retention migration yet still gets Trash/Spam retention.
		console.error("Folder retention could not read folder rules", error);
		return 0;
	}

	for (const rule of rules) {
		if (budget <= 0) break;
		const days = normalizeTrashRetentionDays(rule.days);
		if (!days) continue;
		try {
			const expired = await db
				.select(RETENTION_COLUMNS)
				.from(messages)
				.where(and(
					eq(messages.userId, rule.userId),
					eq(messages.folderId, rule.id),
					lt(messages.createdAt, getTrashRetentionCutoff(now, days)),
					notInArray(messages.status, [...FOLDER_RETENTION_PROTECTED_STATUSES]),
				))
				.orderBy(asc(messages.createdAt), asc(messages.id))
				.limit(budget);
			if (expired.length === 0) continue;
			deleted += await permanentlyDeleteMessages(env, db, rule.userId, expired, "retention");
			budget -= expired.length;
		} catch (error) {
			console.error("Folder retention failed for folder", rule.id, error);
		}
	}
	return deleted;
}
