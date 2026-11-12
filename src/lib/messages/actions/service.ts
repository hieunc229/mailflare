import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { getDb } from "@/db";
import { folders, messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { createAuditLogs } from "@/lib/mailboxes/audit";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { MailboxAccessLevel } from "@/lib/mailboxes/types";
import { applySpamFeedback } from "@/lib/spam/feedback";
import { claimMessageActionUndoToken, releaseMessageActionUndoClaim } from "./claims";
import {
	actionNeedsManage,
	applySnapshotPatch,
	getChangedStateFields,
	getMessageActionPatch,
	isReversibleMessageAction,
	recordHasChanges,
	snapshotMessageState,
	planUndoRecord,
	type MessageActionTarget,
} from "./definitions";
import { MAX_UNDO_AGE_MS, signUndoTokenForEnv, verifyUndoTokenForEnv } from "./token";
import type {
	MessageActionInput,
	MessageActionRecord,
	MessageActionResponse,
	MessageActionSkipped,
	MessageStateSnapshot,
	UndoMessageActionResponse,
} from "./types";

const MAX_ACTION_MESSAGES = 5000;
const MESSAGE_ID_CHUNK = 90;
const MESSAGE_QUERY_CONCURRENCY = 5;

export class MessageActionError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "MessageActionError";
	}
}

type LoadedTarget = MessageActionTarget & { mailboxId: string | null };

function selectTargetChunk(db: AppDatabase, chunk: string[]) {
	return db.select({
		id: messages.id,
		mailboxId: messages.mailboxId,
		direction: messages.direction,
		status: messages.status,
		read: messages.read,
		starred: messages.starred,
		folderId: messages.folderId,
		snoozedUntil: messages.snoozedUntil,
	}).from(messages).where(inArray(messages.id, chunk));
}

async function loadTargets(db: AppDatabase, ids: string[]): Promise<LoadedTarget[]> {
	const chunks: string[][] = [];
	for (let index = 0; index < ids.length; index += MESSAGE_ID_CHUNK) chunks.push(ids.slice(index, index + MESSAGE_ID_CHUNK));
	const rows: LoadedTarget[] = [];
	for (let index = 0; index < chunks.length; index += MESSAGE_QUERY_CONCURRENCY) {
		const batch = await Promise.all(chunks.slice(index, index + MESSAGE_QUERY_CONCURRENCY).map((chunk) => selectTargetChunk(db, chunk)));
		rows.push(...batch.flat());
	}
	return rows;
}

async function loadAccessMap(
	db: AppDatabase,
	user: SessionUser,
	rows: Array<{ mailboxId: string | null }>,
): Promise<Map<string, MailboxAccessLevel | null>> {
	const ids = [...new Set(rows.map((row) => row.mailboxId).filter((id): id is string => !!id))];
	return new Map(await Promise.all(ids.map(async (id) => [id, await getMailboxAccessLevel(db, user, id)] as const)));
}

function normalizeMessageIds(input: MessageActionInput): string[] {
	if (!Array.isArray(input.messageIds)) throw new MessageActionError("Message IDs are required");
	const ids = [...new Set(input.messageIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
	if (ids.length === 0) throw new MessageActionError("Message IDs are required");
	if (ids.length > MAX_ACTION_MESSAGES) throw new MessageActionError(`Select up to ${MAX_ACTION_MESSAGES} messages at a time`);
	return ids;
}

function toDatabasePatch(patch: Partial<MessageStateSnapshot>) {
	const { snoozedUntil, ...fields } = patch;
	return {
		...fields,
		...(snoozedUntil !== undefined
			? { snoozedUntil: snoozedUntil ? new Date(snoozedUntil) : null }
			: {}),
	};
}

function pickStatePatch(
	fields: Array<keyof MessageStateSnapshot>,
	state: MessageStateSnapshot,
): Partial<MessageStateSnapshot> {
	const patch: Partial<MessageStateSnapshot> = {};
	for (const field of fields) patch[field] = state[field] as never;
	return patch;
}

function stateCondition(field: keyof MessageStateSnapshot, expected: MessageStateSnapshot[keyof MessageStateSnapshot]): SQL {
	if (field === "status") return eq(messages.status, expected as string);
	if (field === "read") return eq(messages.read, expected as boolean);
	if (field === "starred") return eq(messages.starred, expected as boolean);
	if (field === "folderId") return expected === null ? isNull(messages.folderId) : eq(messages.folderId, expected as string);
	return expected === null ? isNull(messages.snoozedUntil) : eq(messages.snoozedUntil, new Date(expected as string));
}

function stateConditions(
	fields: Array<keyof MessageStateSnapshot>,
	state: MessageStateSnapshot,
): SQL[] {
	return fields.map((field) => stateCondition(field, state[field]));
}

function validateSnoozeTime(value: string | null | undefined): string {
	if (typeof value !== "string") throw new MessageActionError("Choose a future snooze time");
	const date = new Date(value);
	if (Number.isNaN(date.getTime()) || date <= new Date()) throw new MessageActionError("Choose a future snooze time");
	return date.toISOString();
}

async function loadActionFolder(
	db: AppDatabase,
	user: SessionUser,
	folderId: string | null | undefined,
) {
	if (!folderId) throw new MessageActionError("Folder is required");
	const [folder] = await db.select({ id: folders.id, mailboxId: folders.mailboxId }).from(folders).where(eq(folders.id, folderId)).limit(1);
	if (!folder) throw new MessageActionError("Folder not found", 404);
	const access = await getMailboxAccessLevel(db, user, folder.mailboxId);
	if (!access?.canManage) throw new MessageActionError("Folder not found", 404);
	return folder;
}

/** Applies one explicit action and returns the exact before/after state of every message it changed. */
export async function applyMessageActionForUser(
	env: CloudflareEnv,
	user: SessionUser,
	input: MessageActionInput,
): Promise<MessageActionResponse> {
	if (!isReversibleMessageAction(input.action)) throw new MessageActionError("Invalid message action");
	const action = input.action;
	const ids = normalizeMessageIds(input);
	const snoozedUntil = action === "snooze" ? validateSnoozeTime(input.snoozedUntil) : undefined;
	const db = getDb(env);
	const folder = action === "folder" ? await loadActionFolder(db, user, input.folderId) : null;
	const rows = await loadTargets(db, ids);
	if (rows.length === 0) throw new MessageActionError("No accessible messages", 404);

	const accessByMailbox = await loadAccessMap(db, user, rows);
	const applied: MessageActionRecord[] = [];
	const skipped: MessageActionSkipped[] = [];
	const seen = new Set<string>();

	for (const row of rows) {
		seen.add(row.id);
		if (!row.mailboxId) {
			skipped.push({ id: row.id, reason: "not_found" });
			continue;
		}
		const access = accessByMailbox.get(row.mailboxId);
		const required = actionNeedsManage(action) ? access?.canManage : access?.canRead;
		if (!required) {
			skipped.push({ id: row.id, reason: "forbidden" });
			continue;
		}
		if (action === "folder" && folder && row.mailboxId !== folder.mailboxId) {
			skipped.push({ id: row.id, reason: "not_applicable" });
			continue;
		}

		const result = getMessageActionPatch(action, { folderId: input.folderId, snoozedUntil }, row);
		if (!result.patch) {
			skipped.push({ id: row.id, reason: result.reason });
			continue;
		}
		const previous = snapshotMessageState(row);
		const next = applySnapshotPatch(previous, result.patch);
		const changedFields = getChangedStateFields(previous, next);
		const trainingAction = action === "spam" || (action === "inbox" && row.status === "spam");
		if (changedFields.length === 0 && !trainingAction) continue;

		if (trainingAction) {
			try {
				const classification = action === "spam" ? "spam" : "ham";
				const changed = await applySpamFeedback(env, user, row.id, classification, access);
				if (!changed) {
					skipped.push({ id: row.id, reason: "not_applicable" });
					continue;
				}
			} catch {
				skipped.push({ id: row.id, reason: "failed" });
				continue;
			}
			// Spam feedback writes status/folder itself and is deliberately kept
			// outside the undo contract; no token is issued for these actions.
			// The classifier-training counters are therefore not reversed on undo.
			if (action === "inbox") {
				try {
					const updated = await db.update(messages)
						.set(toDatabasePatch(pickStatePatch(changedFields, next)))
						.where(eq(messages.id, row.id))
						.returning({ id: messages.id });
					if (updated.length === 0) {
						skipped.push({ id: row.id, reason: "not_found" });
						continue;
					}
				} catch {
					skipped.push({ id: row.id, reason: "failed" });
					continue;
				}
			}
			if (recordHasChanges({ previous, applied: next })) {
				applied.push({ id: row.id, mailboxId: row.mailboxId, previous, applied: next });
			}
			continue;
		}

		try {
			// Compare-and-swap on every field this action writes. A concurrent
			// change makes this row stale rather than signing a previous state the
			// server never actually replaced.
			const updated = await db.update(messages)
				.set(toDatabasePatch(pickStatePatch(changedFields, next)))
				.where(and(eq(messages.id, row.id), ...stateConditions(changedFields, previous)))
				.returning({ id: messages.id });
			if (updated.length === 0) {
				skipped.push({ id: row.id, reason: "stale" });
				continue;
			}
		} catch {
			skipped.push({ id: row.id, reason: "failed" });
			continue;
		}
		applied.push({ id: row.id, mailboxId: row.mailboxId, previous, applied: next });
	}

	for (const missing of ids.filter((id) => !seen.has(id))) {
		skipped.push({ id: missing, reason: "not_found" });
	}

	if (applied.length === 0 && skipped.some((item) => item.reason === "failed")) {
		throw new MessageActionError("Could not update messages", 500);
	}

	const changedRecords = applied.filter(recordHasChanges);
	const hasTrainingRecord = action === "spam"
		|| (action === "inbox" && applied.some((record) => record.previous.status === "spam"));
	const auditRecords = action === "spam"
		? []
		: action === "inbox"
			? changedRecords.filter((record) => record.previous.status !== "spam")
			: changedRecords;
	if (auditRecords.length > 0) {
		await createAuditLogs(env, auditRecords.map((record) => ({
			actorUserId: user.id,
			messageId: record.id,
			action: action === "read" || action === "unread" ? "email.read" : "email.delete",
			metadata: { messageAction: action },
		})));
	}

	const undoToken = !hasTrainingRecord && changedRecords.length > 0
		? await signUndoTokenForEnv(env, {
			v: 2,
			issuedAt: Date.now(),
			action,
			userId: user.id,
			nonce: crypto.randomUUID(),
			records: changedRecords,
		})
		: undefined;

	return { ok: true, action, applied, skipped, undoToken };
}

/**
 * Restores only the fields the signed action changed, and only while they still
 * hold its result. The one-time nonce claim blocks replay of a used token. The
 * remaining accepted limit is a never-used token whose field changed away and
 * back again (ABA): the value CAS cannot distinguish that, and a monotonic
 * revision is deliberately deferred to keep this change small.
 */
export async function undoMessageActionForUser(
	env: CloudflareEnv,
	user: SessionUser,
	token: string,
): Promise<UndoMessageActionResponse> {
	const payload = await verifyUndoTokenForEnv(env, token);
	if (!payload || !isReversibleMessageAction(payload.action) || payload.userId !== user.id) {
		throw new MessageActionError("This undo has expired", 410);
	}
	if (payload.records.length === 0) throw new MessageActionError("Nothing to undo");
	if (payload.records.length > MAX_ACTION_MESSAGES) throw new MessageActionError("Too many messages to undo");

	const claimed = await claimMessageActionUndoToken(env, {
		nonce: payload.nonce,
		userId: user.id,
		expiresAt: new Date(Date.now() + MAX_UNDO_AGE_MS),
	});
	if (claimed === "duplicate") {
		throw new MessageActionError("This undo has already been used", 410);
	}

	try {
		return await performUndoMessageAction(env, user, payload);
	} catch (error) {
		// A transient failure must not burn the one-time token: release it so the
		// same signed retry can be attempted again. Field CAS makes a retry safe
		// after any rows that were already restored.
		await releaseMessageActionUndoClaim(env, { nonce: payload.nonce, userId: user.id }).catch(() => undefined);
		throw error;
	}
}

async function performUndoMessageAction(
	env: CloudflareEnv,
	user: SessionUser,
	payload: NonNullable<Awaited<ReturnType<typeof verifyUndoTokenForEnv>>>,
): Promise<UndoMessageActionResponse> {
	const records = [...new Map(payload.records.map((record) => [record.id, record])).values()];
	const db = getDb(env);
	const ids = records.map((record) => record.id);
	const rows = await loadTargets(db, ids);
	const byId = new Map(rows.map((row) => [row.id, row]));
	const accessByMailbox = await loadAccessMap(db, user, rows);
	const folderIds = [...new Set(records.map((record) => record.previous.folderId).filter((id): id is string => !!id))];
	const folderMailboxes = new Map<string, string>();
	for (let index = 0; index < folderIds.length; index += MESSAGE_ID_CHUNK) {
		const chunk = folderIds.slice(index, index + MESSAGE_ID_CHUNK);
		const folderRows = await db.select({ id: folders.id, mailboxId: folders.mailboxId }).from(folders).where(inArray(folders.id, chunk));
		for (const folder of folderRows) folderMailboxes.set(folder.id, folder.mailboxId);
	}

	const restored: string[] = [];
	const skipped: MessageActionSkipped[] = [];

	for (const record of records) {
		const current = byId.get(record.id);
		if (!current) {
			skipped.push({ id: record.id, reason: "not_found" });
			continue;
		}
		const access = current.mailboxId ? accessByMailbox.get(current.mailboxId) : null;
		const plan = planUndoRecord(
			record,
			current,
			{ canRead: !!access?.canRead, canManage: !!access?.canManage },
			record.previous.folderId ? folderMailboxes.get(record.previous.folderId) : null,
		);
		if (!("patch" in plan)) {
			skipped.push({ id: plan.id, reason: plan.reason });
			continue;
		}
		// One row at a time: the MySQL update/returning shim needs an exact
		// per-row affected count, and every dialect gets a real field CAS.
		const updated = await db.update(messages)
			.set(toDatabasePatch(plan.patch))
			.where(and(eq(messages.id, record.id), ...stateConditions(plan.fields, record.applied)))
			.returning({ id: messages.id });
		if (updated.length === 0) {
			skipped.push({ id: record.id, reason: "stale" });
			continue;
		}
		restored.push(record.id);
	}

	if (restored.length > 0) {
		const restoredSet = new Set(restored);
		await createAuditLogs(env, records
			.filter((record) => restoredSet.has(record.id))
			.map((record) => ({
				actorUserId: user.id,
				messageId: record.id,
				action: getChangedStateFields(record.previous, record.applied).every((field) => field === "read" || field === "starred")
					? "email.read"
					: "email.delete",
				metadata: { undoOf: payload.action },
			})));
	}

	return { ok: true, action: payload.action, restored, skipped };
}
