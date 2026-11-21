import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { getDb } from "@/db";
import { schemaDialect } from "@/db/dialect";
import { folders, messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { isOthersDraft } from "@/lib/email/draft-access";
import { createAuditLogs } from "@/lib/mailboxes/audit";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { MailboxAccessLevel } from "@/lib/mailboxes/types";
import { applySpamFeedback } from "@/lib/spam/feedback";
import { claimMessageActionUndoToken, releaseMessageActionUndoClaim } from "./claims";
import {
	actionNeedsManage,
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
	MessageStateField,
	MessageStateSnapshot,
	UndoMessageActionResponse,
} from "./types";

const MAX_ACTION_MESSAGES = 5000;
const MESSAGE_ID_CHUNK = 90;
const MESSAGE_QUERY_CONCURRENCY = 5;
const D1_BOUND_PARAMETER_BUDGET = 90;

export class MessageActionError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "MessageActionError";
	}
}

type LoadedTarget = MessageActionTarget & { mailboxId: string | null; userId: string | null; privateDraft: boolean };

type PlannedUpdate = {
	id: string;
	/** Every field the operation writes; used for both the CAS and the update. */
	fields: MessageStateField[];
	condition: MessageStateSnapshot;
	values: Partial<MessageStateSnapshot>;
};

function selectTargetChunk(db: AppDatabase, chunk: string[]) {
	return db.select({
		id: messages.id,
		userId: messages.userId,
		mailboxId: messages.mailboxId,
		direction: messages.direction,
		privateDraft: messages.privateDraft,
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
	state: Partial<MessageStateSnapshot>,
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

async function updatePlannedRow(
	db: AppDatabase,
	plan: PlannedUpdate,
): Promise<"applied" | "stale" | "failed"> {
	try {
		const updated = await db.update(messages)
			.set(toDatabasePatch(pickStatePatch(plan.fields, plan.values)))
			.where(and(eq(messages.id, plan.id), ...stateConditions(plan.fields, plan.condition)))
			.returning({ id: messages.id });
		return updated.length > 0 ? "applied" : "stale";
	} catch {
		return "failed";
	}
}

function planRowCondition(plan: PlannedUpdate): SQL {
	return and(eq(messages.id, plan.id), ...stateConditions(plan.fields, plan.condition))!;
}

/** Raw-CASE parameter values: timestamps are epoch seconds, SQLite booleans are integers. */
function toCaseValue(field: MessageStateField, value: MessageStateSnapshot[MessageStateField]): unknown {
	if (field === "snoozedUntil") {
		return value === null ? null : Math.floor(new Date(value as string).getTime() / 1000);
	}
	if ((field === "read" || field === "starred") && schemaDialect() === "sqlite") return value ? 1 : 0;
	return value;
}

function countVaryingFields(plans: PlannedUpdate[]): number {
	return plans[0].fields.filter((field) => plans.some((plan) => plan.values[field] !== plans[0].values[field])).length;
}

/** Fields with one target use a plain SET; per-row targets use a CASE expression. */
function buildUpdateSet(plans: PlannedUpdate[]) {
	const fields = plans[0].fields;
	const uniform: Partial<MessageStateSnapshot> = {};
	const cases: Record<string, SQL> = {};
	for (const field of fields) {
		const first = plans[0].values[field];
		if (plans.every((plan) => plan.values[field] === first)) {
			uniform[field] = first as never;
			continue;
		}
		const branches = plans.map((plan) => sql`when ${plan.id} then ${toCaseValue(field, plan.values[field] as never)}`);
		cases[field] = sql`case ${messages.id} ${sql.join(branches, sql` `)} else ${messages[field]} end`;
	}
	return { ...toDatabasePatch(uniform), ...cases };
}

/** Keeps every statement under D1's bound-parameter limit. */
function updateChunkSize(parametersPerRow: number): number {
	return Math.max(1, Math.floor(D1_BOUND_PARAMETER_BUDGET / parametersPerRow));
}

/**
 * Runs bounded CAS updates. SQLite/Postgres group rows by written fields and
 * OR their per-row conditions, so D1's query cap does not turn a large or
 * heterogeneous selection into one query per message. MySQL always writes per
 * row because its RETURNING shim can over-report a concurrently changed batch.
 * Any batch miss falls back to per-row CAS to report the exact stale rows.
 */
async function runPlannedUpdates(
	db: AppDatabase,
	plans: PlannedUpdate[],
): Promise<{ applied: Set<string>; skipped: MessageActionSkipped[] }> {
	const applied = new Set<string>();
	const skipped: MessageActionSkipped[] = [];
	if (schemaDialect() === "mysql") {
		for (const plan of plans) {
			const outcome = await updatePlannedRow(db, plan);
			if (outcome === "applied") applied.add(plan.id);
			else skipped.push({ id: plan.id, reason: outcome });
		}
		return { applied, skipped };
	}

	const groups = new Map<string, PlannedUpdate[]>();
	for (const plan of plans) {
		const key = plan.fields.join("|");
		const group = groups.get(key);
		if (group) group.push(plan);
		else groups.set(key, [plan]);
	}

	for (const group of groups.values()) {
		// One id plus one condition value per field, plus two parameters per CASE branch.
		const parametersPerRow = 1 + group[0].fields.length + countVaryingFields(group) * 2;
		const chunkSize = updateChunkSize(parametersPerRow);
		for (let index = 0; index < group.length; index += chunkSize) {
			const chunk = group.slice(index, index + chunkSize);
			let updatedIds = new Set<string>();
			try {
				const updated = await db.update(messages)
					.set(buildUpdateSet(chunk))
					.where(or(...chunk.map(planRowCondition)))
					.returning({ id: messages.id });
				updatedIds = new Set(updated.map((row) => row.id));
			} catch {
				updatedIds = new Set();
			}

			for (const plan of chunk) {
				const outcome = updatedIds.has(plan.id) ? "applied" : await updatePlannedRow(db, plan);
				if (outcome === "applied") applied.add(plan.id);
				else skipped.push({ id: plan.id, reason: outcome });
			}
		}
	}
	return { applied, skipped };
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
	const plans: Array<{ plan: PlannedUpdate; record: MessageActionRecord }> = [];
	const seen = new Set<string>();

	for (const row of rows) {
		seen.add(row.id);
		// Another user's draft is invisible to this user: report it exactly like a missing message.
		if (!row.mailboxId || isOthersDraft(row, user.id)) {
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
		const next = { ...previous, ...result.patch };
		const fields = Object.keys(result.patch) as MessageStateField[];
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
			// Spam feedback writes status/folder itself and is not undoable.
			if (action === "inbox") {
				const remaining = fields.filter((field) => field !== "status" && field !== "folderId");
				if (remaining.length > 0) {
					try {
						const updated = await db.update(messages)
							.set(toDatabasePatch(pickStatePatch(remaining, next)))
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
			}
			if (recordHasChanges({ previous, applied: next })) {
				applied.push({ id: row.id, mailboxId: row.mailboxId, previous, applied: next });
			}
			continue;
		}

		plans.push({
			plan: { id: row.id, fields, condition: previous, values: next },
			record: { id: row.id, mailboxId: row.mailboxId, previous, applied: next },
		});
	}

	const updates = await runPlannedUpdates(db, plans.map((entry) => entry.plan));
	for (const entry of plans) {
		if (updates.applied.has(entry.plan.id)) applied.push(entry.record);
	}
	skipped.push(...updates.skipped);
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
 * Restores the signed action after claiming its nonce, which blocks replay of a
 * used token. A never-used ABA change still passes the value CAS by design.
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

	// A committed restore keeps the claim; only a zero-progress failure releases it.
	const progress = { restored: 0 };
	try {
		return await performUndoMessageAction(env, user, payload, progress);
	} catch (error) {
		if (progress.restored === 0) {
			await releaseMessageActionUndoClaim(env, { nonce: payload.nonce, userId: user.id }).catch(() => undefined);
		}
		throw error;
	}
}

async function performUndoMessageAction(
	env: CloudflareEnv,
	user: SessionUser,
	payload: NonNullable<Awaited<ReturnType<typeof verifyUndoTokenForEnv>>>,
	progress: { restored: number },
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

	const skipped: MessageActionSkipped[] = [];
	const plans: Array<{ plan: PlannedUpdate; record: MessageActionRecord }> = [];

	for (const record of records) {
		const current = byId.get(record.id);
		if (!current || isOthersDraft(current, user.id)) {
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
		plans.push({
			plan: { id: record.id, fields: plan.fields, condition: record.applied, values: plan.patch },
			record,
		});
	}

	const updates = await runPlannedUpdates(db, plans.map((entry) => entry.plan));
	skipped.push(...updates.skipped);
	const restored = plans
		.filter((entry) => updates.applied.has(entry.plan.id))
		.map((entry) => entry.record.id);
	progress.restored += restored.length;

	if (restored.length === 0 && skipped.some((item) => item.reason === "failed")) {
		throw new MessageActionError("Could not restore messages", 500);
	}

	if (restored.length > 0) {
		const restoredSet = new Set(restored);
		try {
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
		} catch (error) {
			// The restore committed; a failed audit must not make the claim retryable.
			console.error("Message undo audit failed", error);
		}
	}

	return { ok: true, action: payload.action, restored, skipped };
}
