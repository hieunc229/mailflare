import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { conversationLabels, labels } from "@/db/schema";
import { newId } from "@/lib/ids";
import { selectInBatches } from "@/lib/db-params";
import type { NoteConversation } from "@/lib/notes/types";
import type { Label, LabelChip } from "./types";

const labelColumns = { id: labels.id, mailboxId: labels.mailboxId, name: labels.name, color: labels.color };

/** Labels of the given mailboxes, by name. */
export function listLabels(db: AppDatabase, mailboxIds: string[]): Promise<Label[]> {
	if (mailboxIds.length === 0) return Promise.resolve([]);
	return db.select(labelColumns).from(labels).where(inArray(labels.mailboxId, mailboxIds)).orderBy(asc(labels.name));
}

export async function findLabel(db: AppDatabase, labelId: string): Promise<Label | null> {
	const [row] = await db.select(labelColumns).from(labels).where(eq(labels.id, labelId)).limit(1);
	return row ?? null;
}

/** Names are unique per mailbox without regard to case, so "Orders" and "orders" are one label. */
async function nameTaken(db: AppDatabase, mailboxId: string, name: string, exceptId?: string) {
	const [row] = await db
		.select({ id: labels.id })
		.from(labels)
		.where(and(eq(labels.mailboxId, mailboxId), sql`lower(${labels.name}) = ${name.toLowerCase()}`, exceptId ? ne(labels.id, exceptId) : undefined))
		.limit(1);
	return !!row;
}

/** The new label, or null when the mailbox already has one by that name. */
export async function createLabel(db: AppDatabase, mailboxId: string, input: { name: string; color: string }): Promise<Label | null> {
	if (await nameTaken(db, mailboxId, input.name)) return null;
	const label = { id: newId("lbl"), mailboxId, name: input.name, color: input.color };
	await db.insert(labels).values(label);
	return label;
}

export async function updateLabel(db: AppDatabase, label: Label, input: { name?: string; color?: string }): Promise<Label | "duplicate"> {
	if (input.name !== undefined && await nameTaken(db, label.mailboxId, input.name, label.id)) return "duplicate";
	const next = { ...label, ...input };
	await db.update(labels).set({ name: next.name, color: next.color }).where(eq(labels.id, label.id));
	return next;
}

/** Deleting a label takes it off every conversation (the foreign key cascades). */
export async function deleteLabel(db: AppDatabase, labelId: string) {
	await db.delete(labels).where(eq(labels.id, labelId));
}

/** The labels on one conversation, by name. */
export function listConversationLabels(db: AppDatabase, conversation: NoteConversation): Promise<LabelChip[]> {
	return db
		.selectDistinct({ id: labels.id, name: labels.name, color: labels.color })
		.from(conversationLabels)
		.innerJoin(labels, eq(labels.id, conversationLabels.labelId))
		.where(and(eq(conversationLabels.mailboxId, conversation.mailboxId), inArray(conversationLabels.threadKey, conversation.threadKeys)))
		.orderBy(asc(labels.name));
}

/**
 * Puts a label of the conversation's mailbox on it, or takes it off. False when
 * the label belongs to another mailbox. Applying twice is a no-op.
 */
export async function setConversationLabel(db: AppDatabase, conversation: NoteConversation, labelId: string, applied: boolean): Promise<boolean> {
	const label = await findLabel(db, labelId);
	if (!label || label.mailboxId !== conversation.mailboxId) return false;
	const onConversation = and(eq(conversationLabels.labelId, labelId), inArray(conversationLabels.threadKey, conversation.threadKeys));
	if (!applied) {
		await db.delete(conversationLabels).where(onConversation);
		return true;
	}
	const [existing] = await db.select({ id: conversationLabels.id }).from(conversationLabels).where(onConversation).limit(1);
	if (!existing) {
		await db
			.insert(conversationLabels)
			.values({ id: newId("clbl"), labelId, mailboxId: conversation.mailboxId, threadKey: conversation.threadKey, createdAt: new Date() })
			.onConflictDoNothing();
	}
	return true;
}

/**
 * The labels of each list row's conversation, by message id. Rows are keyed
 * like the conversation lookup: their thread, or their own id. The user must
 * already be allowed to read these mailboxes.
 */
export async function labelsForRows(
	db: AppDatabase,
	rows: Array<{ id: string; mailboxId: string | null; threadId: string | null }>,
): Promise<Map<string, LabelChip[]>> {
	const result = new Map<string, LabelChip[]>();
	const scoped = rows.filter((row): row is { id: string; mailboxId: string; threadId: string | null } => !!row.mailboxId);
	if (scoped.length === 0) return result;
	const keys = scoped.flatMap((row) => [row.id, ...(row.threadId ? [row.threadId] : [])]);
	const mailboxIds = [...new Set(scoped.map((row) => row.mailboxId))];
	const found = await selectInBatches(keys, (batch) => db
		.select({ mailboxId: conversationLabels.mailboxId, threadKey: conversationLabels.threadKey, id: labels.id, name: labels.name, color: labels.color })
		.from(conversationLabels)
		.innerJoin(labels, eq(labels.id, conversationLabels.labelId))
		.where(and(inArray(conversationLabels.mailboxId, mailboxIds), inArray(conversationLabels.threadKey, batch))));
	if (found.length === 0) return result;
	found.sort((a, b) => a.name.localeCompare(b.name));
	for (const row of scoped) {
		const chips = new Map<string, LabelChip>();
		for (const label of found) {
			if (label.mailboxId === row.mailboxId && (label.threadKey === row.id || label.threadKey === row.threadId)) {
				chips.set(label.id, { id: label.id, name: label.name, color: label.color });
			}
		}
		if (chips.size > 0) result.set(row.id, [...chips.values()]);
	}
	return result;
}
