import { and, asc, eq, inArray, isNotNull, lt, notExists, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, mailboxes, messages, outboundJobs, users } from "@/db/schema";
import { permanentlyDeleteMessages } from "@/lib/email/permanent-delete";
import {
	FOLDER_RETENTION_ELIGIBLE_STATUSES,
	NON_TERMINAL_OUTBOUND_JOB_STATUSES,
	TRASH_RETENTION_BATCH_SIZE,
	getTrashRetentionCutoff,
	normalizeTrashRetentionDays,
} from "./trash-retention-utils";

type RetentionCandidate = {
	id: string;
	mailboxId: string | null;
	rawR2Key: string | null;
	status: string;
};

/** A candidate re-read at deletion time, with the account whose rule covers it. */
type ClaimedMessage = { row: RetentionCandidate; actorUserId: string };

type Claim = (id: string) => Promise<ClaimedMessage | null>;

type Dispatched = { deleted: number; used: number };

/**
 * Permanently delete mail that has outlived its owner's retention rules. Runs from the scheduled handler;
 * each run attempts at most TRASH_RETENTION_BATCH_SIZE deletions in total, so a big backlog drains over
 * several runs.
 *
 * Two rules feed one budget, in this order:
 *
 * 1. The owner's Trash/Spam retention (`users.trashRetentionDays`): messages whose `trashedAt` is older than
 *    the window, exactly as before folder rules existed.
 * 2. Per-folder retention (`folders.retentionDays`): messages still in a folder whose `createdAt` — the
 *    message date — is older than the folder's window. Only statuses in
 *    FOLDER_RETENTION_ELIGIBLE_STATUSES (`received`, `archived`) are eligible: those are the two normal
 *    "filed" statuses. `draft`/`queued`/`failed` are unsent or still being sent, `sent` is the user's sent
 *    record (JMAP files sent mail into folders as literal `sent`), Trash/Spam are owned by rule 1, and any
 *    status this list does not name — including a future one — is not deletable by a folder rule. The
 *    eligibility list is positive on purpose: `messages.status` is free text, so an unknown value must mean
 *    "keep", never "delete".
 *
 * The folder rule also skips `private_draft` rows and messages a live outbound job still owns, whatever
 * their status says. Product flows rewrite status (`bulk move` turns a queued message into `received`,
 * archive-then-move keeps `private_draft = 1` with status `received`), so provenance and a pending send
 * are checked as their own facts. The Trash rule skips live-job messages too: deleting one would strand a
 * `sending` job with `message_id = NULL` while the send is still using the row and its objects.
 *
 * Both rules age by their own clock: folder rules use `createdAt` (the message's own date, which is what
 * "this folder keeps nothing older than N days" means), while Trash/Spam retention keeps using
 * `trashedAt` (how long it has been thrown away). The rules are additive: either window can remove a
 * message. A file-import writes the message `Date` header into `createdAt`, so old mail imported in bulk
 * is eligible on the very next run — no grace period; that is message-date semantics, and the folder
 * settings route says so.
 *
 * Retention days come from the same 1-365 normaliser both rules use; anything outside that range
 * normalises to null, which means "no rule" — never "keep" and never "delete everything".
 *
 * Budget and fairness: the Trash pass runs first and can spend the whole batch, so a Trash backlog that
 * refills to the cap can starve folder retention indefinitely; within the folder phase, folders are visited
 * oldest-created first and an earlier folder can spend the rest of the budget. Within each owner/folder the
 * order is oldest message date first. That is the intended priority (Trash is the user's explicit "throw
 * away" signal) and every backlog drains over runs.
 *
 * Failure handling: a database or storage error is logged and the run continues — owner discovery, folder
 * discovery and each owner/folder/user claim are all guarded, so `runTrashRetention` reports 0 rather than
 * rejecting when the database is unreachable and the next scheduled run retries. The returned count is the
 * number of messages actually gone, not the number attempted.
 *
 * A message's folder rule follows its `folderId`: deleting the folder clears `folderId` (ON DELETE SET
 * NULL), so its mail falls back to the owner's Trash/Spam rule. Nothing else needs cleaning up.
 */
export async function runTrashRetention(env: CloudflareEnv, now = new Date()): Promise<number> {
	const db = getDb(env);
	let budget = TRASH_RETENTION_BATCH_SIZE;
	let deleted = 0;

	for (const owner of await discoverOwners(db)) {
		if (budget <= 0) break;
		const days = normalizeTrashRetentionDays(owner.days);
		if (!days) continue;
		const cutoff = getTrashRetentionCutoff(now, days);

		let ids: string[];
		try {
			ids = (await db
				.select({ id: messages.id })
				.from(messages)
				.where(and(
					eq(messages.userId, owner.id),
					inArray(messages.status, ["trash", "spam"]),
					lt(messages.trashedAt, cutoff),
					liveOutboundJob(db),
				))
				// Oldest first, so a backlog drains in the order mail arrived in Trash and a capped run is repeatable.
				.orderBy(asc(messages.trashedAt), asc(messages.id))
				.limit(budget)).map((row) => row.id);
		} catch (error) {
			console.error("Trash retention could not select messages for user", owner.id, error);
			continue;
		}
		if (ids.length === 0) continue;

		const result = await destroyClaimedMessages(env, db, ids, budget, (id) => claimOwnerCandidate(db, id, owner.id, cutoff));
		deleted += result.deleted;
		budget -= result.used;
	}

	if (budget > 0) deleted += await runFolderRetention(env, db, now, budget);
	return deleted;
}

/** Owners with a Trash/Spam rule, oldest account first so a capped run always visits them in the same order. */
async function discoverOwners(db: ReturnType<typeof getDb>): Promise<Array<{ id: string; days: number | null }>> {
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

/**
 * The per-folder pass. Candidates are selected per folder (each folder has its own window), then every id is
 * re-read immediately before it is destroyed — see `destroyClaimedMessages`. The owner used for the audit
 * row and the deletion is the mailbox owner from `mailboxes.userId`, which is also the owner a folder is
 * created for: a folder rule belongs to the mailbox, so it covers every message filed in that mailbox's
 * folder, including mail a delegate sent from a shared mailbox. Messages whose `mailboxId` is not the
 * folder's mailbox are never touched, so a row cannot be deleted through a folder it does not belong to.
 */
async function runFolderRetention(
	env: CloudflareEnv,
	db: ReturnType<typeof getDb>,
	now: Date,
	budget: number,
): Promise<number> {
	let deleted = 0;
	let remaining = budget;

	for (const rule of await discoverFolderRules(db)) {
		if (remaining <= 0) break;
		const days = normalizeTrashRetentionDays(rule.days);
		if (!days) continue;
		const cutoff = getTrashRetentionCutoff(now, days);

		let ids: string[];
		try {
			ids = (await db
				.select({ id: messages.id })
				.from(messages)
				.where(and(
					eq(messages.folderId, rule.id),
					eq(messages.mailboxId, rule.mailboxId),
					inArray(messages.status, [...FOLDER_RETENTION_ELIGIBLE_STATUSES]),
					eq(messages.privateDraft, false),
					lt(messages.createdAt, cutoff),
					liveOutboundJob(db),
				))
				.orderBy(asc(messages.createdAt), asc(messages.id))
				.limit(remaining)).map((row) => row.id);
		} catch (error) {
			console.error("Folder retention could not select messages for folder", rule.id, error);
			continue;
		}
		if (ids.length === 0) continue;

		const result = await destroyClaimedMessages(env, db, ids, remaining, (id) => claimFolderCandidate(db, id, rule.id, now));
		deleted += result.deleted;
		remaining -= result.used;
	}
	return deleted;
}

async function discoverFolderRules(
	db: ReturnType<typeof getDb>,
): Promise<Array<{ id: string; mailboxId: string; days: number | null }>> {
	try {
		return await db
			.select({ id: folders.id, mailboxId: folders.mailboxId, days: folders.retentionDays })
			.from(folders)
			.where(isNotNull(folders.retentionDays))
			.orderBy(asc(folders.createdAt), asc(folders.id));
	} catch (error) {
		// A database that has not run the folder-retention migration yet still gets Trash/Spam retention.
		console.error("Folder retention could not read folder rules", error);
		return [];
	}
}

/**
 * Destroy the given ids one at a time, re-reading each one first.
 *
 * The candidate list is a snapshot: between selecting it and reaching an id the user can move the message
 * out of the ruled folder, clear or lengthen the rule, restore it from Trash, or delete it themselves. So
 * each id is re-checked with `claim` before the first destructive call (the attachment/raw-object delete in
 * `permanentlyDeleteMessages`), and skipped when it no longer qualifies. A conditional row delete after the
 * object delete would leave the object gone for a message that survived — this claims first, then destroys.
 *
 * The narrow window that remains is between the claim read and the destructive call: a move that commits in
 * those few milliseconds still loses the message. The window cannot be closed without a database
 * transaction that spans object storage (which R2/D1 cannot do); it is milliseconds wide and needs a
 * deliberate concurrent move of a message that was already past its retention window.
 *
 * One unit of the shared budget is reserved before each destructive attempt, so a batch that fails partway
 * cannot hand the rest of its budget to the next pass (which is how 200 reported deletions once became 399
 * physical ones). A skip gives the unit back because nothing was destroyed; a claim that throws keeps its
 * unit, so a flaky database still bounds the work one run can do. `deleted` counts rows that are actually
 * gone: when the delete throws after removing the row (for example an audit insert failure) the message is
 * re-read to find out, so the returned count matches reality instead of attempts.
 */
async function destroyClaimedMessages(
	env: CloudflareEnv,
	db: ReturnType<typeof getDb>,
	ids: string[],
	budget: number,
	claim: Claim,
): Promise<Dispatched> {
	let deleted = 0;
	let used = 0;

	for (const id of ids) {
		if (used >= budget) break;
		used += 1;

		let claimed: ClaimedMessage | null;
		try {
			claimed = await claim(id);
		} catch (error) {
			// A failed re-read destroys nothing; the message stays and the next run retries.
			console.error("Retention could not re-check message", id, error);
			continue;
		}
		if (!claimed) {
			used -= 1;
			continue;
		}

		try {
			await permanentlyDeleteMessages(env, db, claimed.actorUserId, [claimed.row], "retention");
			deleted += 1;
		} catch (error) {
			console.error("Retention failed to delete message", id, error);
			if (!(await messageStillExists(db, id))) deleted += 1;
		}
	}
	return { deleted, used };
}

/** Re-check a Trash/Spam candidate: still the owner's, still trashed, still past the window, no live send. */
async function claimOwnerCandidate(
	db: ReturnType<typeof getDb>,
	id: string,
	ownerUserId: string,
	cutoff: Date,
): Promise<ClaimedMessage | null> {
	const [row] = await db
		.select({ id: messages.id, mailboxId: messages.mailboxId, rawR2Key: messages.rawR2Key, status: messages.status })
		.from(messages)
		.where(and(
			eq(messages.id, id),
			eq(messages.userId, ownerUserId),
			inArray(messages.status, ["trash", "spam"]),
			lt(messages.trashedAt, cutoff),
			liveOutboundJob(db),
		))
		.limit(1);
	if (!row) return null;
	return { row, actorUserId: ownerUserId };
}

/**
 * Re-check a folder candidate against the folder's *current* rule and the message's *current* folder,
 * status, draft flag and mailbox. The rule is looked up again rather than trusted from the snapshot, so a
 * cleared rule, a lengthened window or a move to another folder all make the message survive.
 */
async function claimFolderCandidate(
	db: ReturnType<typeof getDb>,
	id: string,
	folderId: string,
	now: Date,
): Promise<ClaimedMessage | null> {
	const [row] = await db
		.select({
			id: messages.id,
			mailboxId: messages.mailboxId,
			rawR2Key: messages.rawR2Key,
			status: messages.status,
			createdAt: messages.createdAt,
			retentionDays: folders.retentionDays,
			ownerUserId: mailboxes.userId,
		})
		.from(messages)
		.innerJoin(folders, eq(folders.id, messages.folderId))
		.innerJoin(mailboxes, eq(mailboxes.id, folders.mailboxId))
		.where(and(
			eq(messages.id, id),
			eq(messages.folderId, folderId),
			eq(messages.mailboxId, folders.mailboxId),
			inArray(messages.status, [...FOLDER_RETENTION_ELIGIBLE_STATUSES]),
			eq(messages.privateDraft, false),
			liveOutboundJob(db),
		))
		.limit(1);
	if (!row) return null;

	const days = normalizeTrashRetentionDays(row.retentionDays);
	if (!days) return null;
	if (!row.createdAt || row.createdAt.getTime() >= getTrashRetentionCutoff(now, days).getTime()) return null;

	return {
		row: { id: row.id, mailboxId: row.mailboxId, rawR2Key: row.rawR2Key, status: row.status },
		actorUserId: row.ownerUserId,
	};
}

/** True when a non-terminal outbound job still owns the message, whatever its display status says. */
function liveOutboundJob(db: ReturnType<typeof getDb>) {
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

async function messageStillExists(db: ReturnType<typeof getDb>, id: string): Promise<boolean> {
	try {
		const [row] = await db.select({ id: messages.id }).from(messages).where(eq(messages.id, id)).limit(1);
		return Boolean(row);
	} catch (error) {
		// Cannot tell: report no deletion rather than claim one that may not have happened.
		console.error("Retention could not confirm deletion of message", id, error);
		return true;
	}
}
