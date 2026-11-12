import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { getDb } from "@/db";
import { folders, messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { createAuditLogs } from "@/lib/mailboxes/audit";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { MailboxAccessLevel } from "@/lib/mailboxes/types";
import { applySpamFeedback } from "@/lib/spam/feedback";
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
import { signUndoTokenForEnv, verifyUndoTokenForEnv } from "./token";
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
	const confirmed = new Set<string>();
	const updates = new Map<string, { patch: Partial<MessageStateSnapshot>; ids: string[] }>();
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

		try {
			if (action === "spam") {
				const changed = await applySpamFeedback(env, user, row.id, "spam", access);
				if (!changed) {
					skipped.push({ id: row.id, reason: "not_applicable" });
					continue;
				}
				confirmed.add(row.id);
			}
			if (action === "inbox" && row.status === "spam") {
				await applySpamFeedback(env, user, row.id, "ham", access);
			}
		} catch {
			skipped.push({ id: row.id, reason: "failed" });
			continue;
		}

		applied.push({ id: row.id, mailboxId: row.mailboxId, previous, applied: next });

		// Spam feedback already wrote status/folder; every other path writes the full
		// patch so the stored row is exactly the applied state the token promises.
		if (action !== "spam") {
			const patch = getChangedStateFields(previous, next).length > 0 ? result.patch : null;
			if (patch) {
				const key = JSON.stringify(patch);
				const group = updates.get(key) ?? { patch, ids: [] };
				group.ids.push(row.id);
				updates.set(key, group);
			} else {
				confirmed.add(row.id);
			}
		}
	}

	for (const missing of ids.filter((id) => !seen.has(id))) {
		skipped.push({ id: missing, reason: "not_found" });
	}

	for (const group of updates.values()) {
		for (let index = 0; index < group.ids.length; index += MESSAGE_ID_CHUNK) {
			const chunk = group.ids.slice(index, index + MESSAGE_ID_CHUNK);
			try {
				await db.update(messages).set(toDatabasePatch(group.patch)).where(inArray(messages.id, chunk));
				for (const id of chunk) confirmed.add(id);
			} catch {
				for (const id of chunk) skipped.push({ id, reason: "failed" });
			}
		}
	}

	const confirmedApplied = applied.filter((record) => confirmed.has(record.id));
	if (confirmedApplied.length === 0 && skipped.some((item) => item.reason === "failed")) {
		throw new MessageActionError("Could not update messages", 500);
	}

	const changedRecords = confirmedApplied.filter(recordHasChanges);
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

	const undoToken = changedRecords.length > 0
		? await signUndoTokenForEnv(env, {
			v: 1,
			issuedAt: Date.now(),
			action,
			records: changedRecords,
		})
		: undefined;

	return { ok: true, action, applied: confirmedApplied, skipped, undoToken };
}

/** Restores only the fields the signed action changed, and only while they still hold its result. */
export async function undoMessageActionForUser(
	env: CloudflareEnv,
	user: SessionUser,
	token: string,
): Promise<UndoMessageActionResponse> {
	const payload = await verifyUndoTokenForEnv(env, token);
	if (!payload || !isReversibleMessageAction(payload.action)) {
		throw new MessageActionError("This undo has expired", 410);
	}
	if (payload.records.length === 0) throw new MessageActionError("Nothing to undo");
	if (payload.records.length > MAX_ACTION_MESSAGES) throw new MessageActionError("Too many messages to undo");

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
	const updates = new Map<string, {
		patch: Partial<MessageStateSnapshot>;
		fields: (keyof MessageStateSnapshot)[];
		applied: MessageStateSnapshot;
		ids: string[];
	}>();

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
		const key = JSON.stringify({ patch: plan.patch, applied: plan.fields.map((field) => record.applied[field]) });
		const group = updates.get(key) ?? { patch: plan.patch, fields: plan.fields, applied: record.applied, ids: [] };
		group.ids.push(record.id);
		updates.set(key, group);
	}

	for (const group of updates.values()) {
		for (let index = 0; index < group.ids.length; index += MESSAGE_ID_CHUNK) {
			const chunk = group.ids.slice(index, index + MESSAGE_ID_CHUNK);
			const conditions = [inArray(messages.id, chunk)];
			for (const field of group.fields) {
				const expected = group.applied[field];
				if (field === "status") conditions.push(eq(messages.status, expected as string));
				else if (field === "read") conditions.push(eq(messages.read, expected as boolean));
				else if (field === "starred") conditions.push(eq(messages.starred, expected as boolean));
				else if (field === "folderId") conditions.push(expected === null ? isNull(messages.folderId) : eq(messages.folderId, expected as string));
				else if (field === "snoozedUntil") conditions.push(expected === null ? isNull(messages.snoozedUntil) : eq(messages.snoozedUntil, new Date(expected as string)));
			}
			try {
				// Compare-and-swap on the exact fields the action wrote, so a later
				// change in another tab or request wins instead of being clobbered.
				const updated = await db.update(messages)
					.set(toDatabasePatch(group.patch))
					.where(and(...conditions))
					.returning({ id: messages.id });
				const updatedIds = new Set(updated.map((row) => row.id));
				for (const id of chunk) {
					if (updatedIds.has(id)) restored.push(id);
					else skipped.push({ id, reason: "stale" });
				}
			} catch {
				for (const id of chunk) skipped.push({ id, reason: "failed" });
			}
		}
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
