import { and, asc, eq, exists, inArray, isNotNull, lt, ne, notExists, sql, type SQL } from "drizzle-orm";
import { type AppDatabase, getDb } from "@/db";
import { folders, mailboxes, messageAttachments, messages, outboundJobs, users } from "@/db/schema";
import { cleanupClaimedMessageObjects } from "@/lib/email/permanent-delete";
import {
	FOLDER_RETENTION_ELIGIBLE_STATUSES,
	NON_TERMINAL_OUTBOUND_JOB_STATUSES,
	TRASH_RETENTION_BATCH_SIZE,
	getTrashRetentionCutoff,
	normalizeTrashRetentionDays,
} from "./trash-retention-utils";

/** A folder rule as it stood when the run started. */
type FolderRule = {
	id: string;
	mailboxId: string;
	ownerUserId: string;
	days: number | null;
};

type OwnerRule = { id: string; days: number | null };

type Dispatched = { deleted: number; used: number };

/** A message the conditional delete removed, with what is needed to clean up after it. */
type ClaimedRow = {
	id: string;
	mailboxId: string | null;
	status: string;
	rawR2Key: string | null;
};

/**
 * Permanently delete mail that has outlived its owner's retention rules. Runs from the scheduled handler;
 * each run attempts at most TRASH_RETENTION_BATCH_SIZE claims in total, so a big backlog drains over
 * several runs.
 *
 * Two rules feed one budget, in this order:
 *
 * 1. The owner's Trash/Spam retention (`users.trashRetentionDays`): messages whose `trashedAt` is older than
 *    the window, exactly as before folder rules existed. Sent mail the user threw away on purpose is purged
 *    here like any other Trash mail.
 * 2. Per-folder retention (`folders.retentionDays`): messages still in a folder whose `createdAt` — the
 *    message date — is older than the folder's window.
 *
 * What a folder rule may delete is a positive list, because `messages.status` is free text:
 *
 * - `status` must be in FOLDER_RETENTION_ELIGIBLE_STATUSES (`received`, `archived`). `draft`/`queued`/`failed`
 *   are unsent or still being sent, `sent` is the user's sent record (JMAP files sent mail into folders as
 *   literal `sent`), Trash/Spam belong to rule 1, and an unknown or future status means "keep".
 * - `direction` must not be `outbound`. Status alone cannot see provenance: the web send path completes a
 *   scheduled message, the bulk folder action rewrites it to `received`, and the message then has no job
 *   status left to protect it. `direction` is written by every send path, by imported Sent/Drafts mail, and is
 *   never rewritten by filing, so filed sent copies (including imported ones with no outbound job) stay out
 *   of the folder rule's reach.
 * - `private_draft` must be false: archive-then-move keeps the flag but rewrites the status, and an unsent
 *   draft is the user's work. (The Trash rule still removes drafts the user threw away themselves, as before.)
 * - no non-terminal `outbound_jobs` row (`queued`, `sending`) may own the message, in either rule: the FK is
 *   ON DELETE SET NULL, so deleting the row would strand a live send.
 *
 * The two rules age by their own clock: folder rules use `createdAt` (the message's own date, which is what
 * "this folder keeps nothing older than N days" means), while Trash/Spam retention uses `trashedAt` (how long
 * it has been thrown away). They are additive: either window can remove a message a rule covers. A file
 * import writes the message `Date` header into `createdAt`, so old mail imported in bulk is eligible on the
 * next run — no grace period, by design; the folder settings route says so.
 *
 * The whole eligibility decision is one conditional `DELETE`: see `destroyClaimedMessages`.
 *
 * Rule timing: both rule sets are read once, before any deletion, so a rule enabled in the middle of a run
 * applies from the next run for every phase alike. Age windows come from that snapshot, and the conditional
 * delete only proceeds while the rule still *has* the snapshotted value — so lengthening a rule mid-run spares
 * the mail the new rule protects, clearing it stops immediately, and every other change (including
 * disable/enable and clear/re-enable to another value) defers to the next run. The claim also re-reads the
 * folder's current mailbox and that mailbox's owner, so the mailbox binding and the audit actor are current
 * truth rather than snapshot values.
 *
 * Budget and fairness: the Trash pass runs first and can spend the whole batch, so a Trash backlog that
 * refills to the cap can starve folder retention indefinitely; within the folder phase, folders are visited
 * oldest-created first and an earlier folder can spend the rest of the budget. Within each owner/folder the
 * order is oldest message date first. That is the intended priority (Trash is the user's explicit "throw
 * away" signal) and every backlog drains over runs.
 *
 * Failure handling: a database or storage error is logged and the run continues. Rule discovery and the
 * database binding itself are guarded too, so `runTrashRetention` reports 0 rather than rejecting when the
 * database is missing or unreachable, and the next scheduled run retries. The returned count is the number of
 * rows this run actually removed.
 *
 * A message's folder rule follows its `folderId`: deleting the folder clears `folderId` (ON DELETE SET NULL),
 * so its mail falls back to the owner's Trash/Spam rule. Nothing else needs cleaning up.
 */
export async function runTrashRetention(env: CloudflareEnv, now = new Date()): Promise<number> {
	const db = openDatabase(env);
	if (!db) return 0;

	// Snapshot every rule before the first delete, so mid-run enables are consistent across both phases.
	const owners = await discoverOwners(db);
	const rules = await discoverFolderRules(db);

	let budget = TRASH_RETENTION_BATCH_SIZE;
	let deleted = 0;

	for (const owner of owners) {
		if (budget <= 0) break;
		const days = normalizeTrashRetentionDays(owner.days);
		if (!days) continue;
		const cutoff = getTrashRetentionCutoff(now, days);
		const eligible = and(
			eq(messages.userId, owner.id),
			inArray(messages.status, ["trash", "spam"]),
			lt(messages.trashedAt, cutoff),
			liveOutboundJob(db),
		);

		let ids: string[];
		try {
			ids = (await db
				.select({ id: messages.id })
				.from(messages)
				.where(eligible)
				// Oldest first, so a backlog drains in the order mail arrived in Trash and a capped run is repeatable.
				.orderBy(asc(messages.trashedAt), asc(messages.id))
				.limit(budget)).map((row) => row.id);
		} catch (error) {
			console.error("Trash retention could not select messages for user", owner.id, error);
			continue;
		}
		if (ids.length === 0) continue;

		const result = await destroyClaimedMessages(env, db, ids, budget, (id) => (
			and(eq(messages.id, id), eligible, currentGlobalRule(db, owner.id, days))
		), owner.id);
		deleted += result.deleted;
		budget -= result.used;
	}

	if (budget > 0) deleted += await runFolderRetention(env, db, now, budget, rules);
	return deleted;
}

/**
 * The per-folder pass. `rules` is the run-start snapshot: a rule created after this point is not applied
 * until the next run, which is the same for a rule enabled during the Trash phase and one enabled during the
 * folder phase. Each candidate is still deleted through `destroyClaimedMessages`, which re-checks the rule's
 * current presence, so clearing a rule stops it immediately.
 *
 * The audit actor is the mailbox owner (`mailboxes.userId`), which is the account a folder is created for: a
 * folder rule belongs to the mailbox, so it covers every message filed in that mailbox's folder, including
 * mail a delegate sent from a shared mailbox. The conditional delete requires `messages.mailboxId` to be the
 * folder's mailbox, so a row cannot be deleted through a folder it does not belong to.
 */
async function runFolderRetention(
	env: CloudflareEnv,
	db: AppDatabase,
	now: Date,
	budget: number,
	rules: FolderRule[],
): Promise<number> {
	let deleted = 0;
	let remaining = budget;

	for (const rule of rules) {
		if (remaining <= 0) break;
		const days = normalizeTrashRetentionDays(rule.days);
		if (!days) continue;
		const cutoff = getTrashRetentionCutoff(now, days);
		const eligible = folderEligibility(db, rule, cutoff);

		let ids: string[];
		try {
			ids = (await db
				.select({ id: messages.id })
				.from(messages)
				.where(eligible)
				.orderBy(asc(messages.createdAt), asc(messages.id))
				.limit(remaining)).map((row) => row.id);
		} catch (error) {
			console.error("Folder retention could not select messages for folder", rule.id, error);
			continue;
		}
		if (ids.length === 0) continue;

		const result = await destroyClaimedMessages(env, db, ids, remaining, (id) => (
			and(eq(messages.id, id), eligible, currentFolderRule(db, rule, days))
		), rule.ownerUserId);
		deleted += result.deleted;
		remaining -= result.used;
	}
	return deleted;
}

/** The predicate every folder-rule candidate must satisfy, re-expressed on the delete itself. */
function folderEligibility(db: AppDatabase, rule: FolderRule, cutoff: Date): SQL | undefined {
	return and(
		eq(messages.folderId, rule.id),
		eq(messages.mailboxId, rule.mailboxId),
		inArray(messages.status, [...FOLDER_RETENTION_ELIGIBLE_STATUSES]),
		eq(messages.privateDraft, false),
		ne(messages.direction, "outbound"),
		lt(messages.createdAt, cutoff),
		liveOutboundJob(db),
	);
}

/** Owners with a Trash/Spam rule, oldest account first so a capped run always visits them in the same order. */
async function discoverOwners(db: AppDatabase): Promise<OwnerRule[]> {
	try {
		return await db
			.select({ id: users.id, days: users.trashRetentionDays })
			.from(users)
			.where(isNotNull(users.trashRetentionDays))
			.orderBy(asc(users.createdAt), asc(users.id));
	} catch (error) {
		console.error("Trash retention could not list owners", error);
		return [];
	}
}

/** Folder rules with their mailbox owner, oldest folder first so a capped run is repeatable. */
async function discoverFolderRules(db: AppDatabase): Promise<FolderRule[]> {
	try {
		return await db
			.select({ id: folders.id, mailboxId: folders.mailboxId, days: folders.retentionDays, ownerUserId: mailboxes.userId })
			.from(folders)
			.innerJoin(mailboxes, eq(mailboxes.id, folders.mailboxId))
			.where(isNotNull(folders.retentionDays))
			.orderBy(asc(folders.createdAt), asc(folders.id));
	} catch (error) {
		// A database that has not run the folder-retention migration yet still gets Trash/Spam retention.
		console.error("Folder retention could not read folder rules", error);
		return [];
	}
}

/** The binding itself can be missing (no `env.DB`) or broken; retention must not take the scheduler down. */
function openDatabase(env: CloudflareEnv): AppDatabase | null {
	try {
		return getDb(env);
	} catch (error) {
		console.error("Retention skipped: the database binding is unavailable", error);
		return null;
	}
}

/**
 * Delete the given ids one at a time. For each id the order is:
 *
 * 1. read the attachment keys (they cascade away with the row, so they must be captured first),
 * 2. one conditional `DELETE ... RETURNING` that re-expresses the whole eligibility predicate,
 * 3. only when that delete removed the row, clean up the objects and write the audit row.
 *
 * Step 2 is native on SQLite/D1 and PostgreSQL. MySQL has no `DELETE ... RETURNING`, so the driver shim
 * (`src/db/compat.ts`) reads the matching row and then runs the same conditional DELETE, returning the
 * preselection only when `affectedRows > 0`. The decision is still the DELETE's, but the *cleanup payload*
 * (the raw key and status used for the audit row) can be a moment stale on MySQL if the row is rewritten in
 * between; the object actually cleaned is the one the preselection saw. Every dialect still deletes objects
 * only for a row the conditional DELETE removed, which is the guarantee that matters here.
 *
 * Step 2 is the claim: it is a single atomic statement, so a move to another folder, a rule clear, a status
 * change or a new live send that commits at any point before it makes the delete match nothing. Nothing is
 * deleted from object storage unless the database delete actually removed this row, so a move that wins the
 * race keeps its message *and* its raw MIME and attachments. Re-reading eligibility in a separate SELECT and
 * then deleting objects would not give that: the attachment and shared-object lookups run between the two.
 *
 * The window that remains is after step 2 and before the object deletes: if the process dies or storage
 * fails in between, the row is gone and some objects are orphaned. That direction is deliberate — an orphaned
 * object costs storage, while the reverse (objects deleted for a message that survived) destroys mail the user
 * still has. Cleanup is therefore idempotent and only ever follows a successful claim, and a storage failure
 * gets one immediate retry for this run's own claimed keys (`permanent-delete.ts`).
 *
 * ACCEPTED LIMITATION: if that retry also fails, or the process dies in the window, the objects are
 * **retained indefinitely**. There is no reaper for them in this change, by design: reclaiming them safely
 * means serializing reference creation (an attachment being saved to Drive) against object deletion, which
 * needs writer coordination — a GC claim table that both the save-to-Drive path and the deleter honour in one
 * transaction. That is a design slice of its own; a bucket-wide sweep without it can delete bytes of a live
 * Drive file (the reference lookup and the save are not serialized). The volume is bounded by the crash or
 * storage-failure window rather than by mailbox size, and it is storage cost only — no message row is
 * resurrected or lost by leaving these objects in place.
 *
 * One unit of the shared budget is reserved before each claim, and a claim that matches nothing gives it back
 * because nothing was destroyed. A failed claim keeps its unit, so a flaky database still bounds the work a
 * single run can do. `deleted` counts rows actually removed, and the row is counted even if its object
 * cleanup fails afterwards.
 */
async function destroyClaimedMessages(
	env: CloudflareEnv,
	db: AppDatabase,
	ids: string[],
	budget: number,
	claim: (id: string) => SQL | undefined,
	actorUserId: string,
): Promise<Dispatched> {
	let deleted = 0;
	let used = 0;

	for (const id of ids) {
		if (used >= budget) break;
		used += 1;

		let attachmentKeys: string[];
		try {
			const rows = await db
				.select({ r2Key: messageAttachments.r2Key })
				.from(messageAttachments)
				.where(eq(messageAttachments.messageId, id));
			attachmentKeys = rows.flatMap((row) => row.r2Key ? [row.r2Key] : []);
		} catch (error) {
			console.error("Retention could not read the objects of message", id, error);
			continue;
		}

		let removed: ClaimedRow[];
		try {
			removed = await db
				.delete(messages)
				.where(claim(id))
				.returning({ id: messages.id, mailboxId: messages.mailboxId, status: messages.status, rawR2Key: messages.rawR2Key });
		} catch (error) {
			console.error("Retention could not claim message", id, error);
			continue;
		}

		const row = removed[0];
		if (!row) {
			// The message moved, the rule went away or it is no longer eligible: nothing was touched.
			used -= 1;
			continue;
		}

		deleted += 1;
		try {
			await cleanupClaimedMessageObjects(env, db, actorUserId, row, attachmentKeys);
		} catch (error) {
			// The row is gone, so the deletion happened; only its objects may be left behind.
			console.error("Retention deleted message", id, "but could not remove all of its objects", error);
		}
	}
	return { deleted, used };
}

/**
 * True when the owner's Trash/Spam rule still stands exactly as the snapshot saw it: same owner, same days.
 *
 * Presence is not enough. Lengthening a rule (7 -> 365) during a run must spare the mail the new rule protects,
 * and a clear-and-re-enable lands on a different value in every case except a no-op. So the claim requires
 * `users.trash_retention_days` to equal the snapshot value the cutoff was computed from; any other value — a
 * change, a clear, or a disable/enable cycle — makes the conditional delete match nothing and the rule applies
 * from the next run. A change that puts the value back to exactly the snapshot value is, by definition, the
 * same rule the cutoff was built for, so proceeding is correct.
 */
function currentGlobalRule(db: AppDatabase, userId: string, days: number) {
	return exists(
		db
			.select({ one: sql`1` })
			.from(users)
			.where(and(eq(users.id, userId), eq(users.trashRetentionDays, days))),
	);
}

/**
 * True when the folder rule still stands exactly as the snapshot saw it, bound to *current* truth:
 *
 * - the folder still exists and `folders.retention_days` still equals the snapshotted value (a lengthened,
 *   shortened, cleared or re-enabled rule all defer to the next run); and
 * - the folder is still in the same mailbox as the message being deleted (`folders.mailbox_id =
 *   messages.mailbox_id`, read now, not from the snapshot), so a folder moved to another mailbox cannot
 *   delete mail that stayed behind; and
 * - that mailbox's owner is still the snapshot owner, so the audit actor is the current owner of the rule
 *   rather than a stale one; if ownership changed the row waits for the next run, which discovers the new
 *   owner.
 */
function currentFolderRule(db: AppDatabase, rule: FolderRule, days: number) {
	return exists(
		db
			.select({ one: sql`1` })
			.from(folders)
			.innerJoin(mailboxes, eq(mailboxes.id, folders.mailboxId))
			.where(and(
				eq(folders.id, rule.id),
				eq(folders.retentionDays, days),
				eq(folders.mailboxId, messages.mailboxId),
				eq(mailboxes.userId, rule.ownerUserId),
			)),
	);
}

/** True when a non-terminal outbound job still owns the message, whatever its display status says. */
function liveOutboundJob(db: AppDatabase) {
	return notExists(
		db
			.select({ one: sql`1` })
			.from(outboundJobs)
			.where(and(
				eq(outboundJobs.messageId, messages.id),
				inArray(outboundJobs.status, [...NON_TERMINAL_OUTBOUND_JOB_STATUSES]),
			)),
	);
}
