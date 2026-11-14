import type { Message } from "@/hooks/types";
import type { MessageMembershipState } from "./change-events";
import {
	getListMembershipContext,
	getListMembershipKey,
	messageMatchesFolder,
	type MessageMembershipFields,
} from "./list-membership";

export type MembershipPatch = Partial<MessageMembershipFields>;

/** The compact fields needed to derive an optimistic move target. */
export type KnownMembershipRow = Pick<
	Message,
	| "id"
	| "mailboxId"
	| "direction"
	| "status"
	| "read"
	| "starred"
	| "folderId"
	| "snoozedUntil"
	| "threadId"
	| "threadMessageIds"
>;

export type RestoredRow = {
	row: Message;
	index: number;
	offset: number;
	eligible: string[];
};

type PendingLayer = Map<string, MembershipPatch>;

type Tombstone = {
	key: string;
	row: Message;
	removedIds: string[];
	index: number;
	offset: number;
	expiresAt: number;
};

const TOMBSTONE_TTL_MS = 2 * 60_000;
const TOMBSTONE_LIMIT = 200;
const KNOWN_ROW_LIMIT = 5_000;
const GROUPED_MEMBER_LIMIT = 10_000;

const knownRows = new Map<string, KnownMembershipRow>();
const groupedMembers = new Map<string, true>();
const pendingLayers = new Map<string, PendingLayer>();
const listeners = new Set<() => void>();
let tombstones: Tombstone[] = [];
const restoredIds = new Set<string>();

function notify(): void {
	for (const listener of [...listeners]) listener();
}

function membershipFieldsOf(row: Pick<Message, "status" | "folderId" | "snoozedUntil" | "starred">): MessageMembershipFields {
	return {
		status: row.status,
		folderId: row.folderId ?? null,
		snoozedUntil: row.snoozedUntil ?? null,
		starred: row.starred,
	};
}

function compactRow(row: Message): KnownMembershipRow {
	return {
		id: row.id,
		mailboxId: row.mailboxId,
		direction: row.direction,
		status: row.status,
		read: row.read,
		starred: row.starred,
		folderId: row.folderId ?? null,
		snoozedUntil: row.snoozedUntil ?? null,
		threadId: row.threadId,
		threadMessageIds: row.threadMessageIds ? [...row.threadMessageIds] : undefined,
	};
}

function rowIdentity(row: Pick<Message, "id" | "threadId" | "threadMessageIds">): string {
	// Only a grouped row identifies the whole conversation. An ungrouped list
	// can contain several messages from one thread, each with its own row.
	return row.threadMessageIds?.length && row.threadId ? `thread:${row.threadId}` : `id:${row.id}`;
}

function capInsertionOrdered<T>(map: Map<string, T>, limit: number): void {
	while (map.size > limit) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

/** List and thread ingress keep the fields an optimistic target needs. */
export function rememberMembershipRows(rows: Message[]): void {
	for (const row of rows) {
		const compact = compactRow(row);
		knownRows.delete(row.id);
		knownRows.set(row.id, compact);
		if (row.threadMessageIds?.length) {
			groupedMembers.set(row.id, true);
			for (const id of row.threadMessageIds) {
				if (!knownRows.has(id)) knownRows.set(id, compact);
				groupedMembers.set(id, true);
			}
		}
	}
	capInsertionOrdered(knownRows, KNOWN_ROW_LIMIT);
	capInsertionOrdered(groupedMembers, GROUPED_MEMBER_LIMIT);
}

export function getKnownMembershipRow(id: string): KnownMembershipRow | undefined {
	return knownRows.get(id);
}

/** A grouped member only exposes its representative's direction. */
export function isGroupedMember(id: string): boolean {
	return groupedMembers.has(id);
}

export function setMembershipOverlay(
	owner: string,
	entries: Array<{ id: string } & MembershipPatch>,
): void {
	if (!owner) return;
	const layer: PendingLayer = new Map();
	for (const entry of entries) {
		const patch: MembershipPatch = {};
		if (entry.status !== undefined) patch.status = entry.status;
		if (entry.folderId !== undefined) patch.folderId = entry.folderId;
		if (entry.snoozedUntil !== undefined) patch.snoozedUntil = entry.snoozedUntil;
		if (entry.starred !== undefined) patch.starred = entry.starred;
		if (Object.keys(patch).length > 0) layer.set(entry.id, patch);
	}
	if (layer.size === 0) {
		clearMembershipOverlay(owner);
		return;
	}
	// An existing owner keeps its map position, so a newer operation stays last.
	pendingLayers.set(owner, layer);
	notify();
}

export function clearMembershipOverlay(owner: string): boolean {
	if (!pendingLayers.delete(owner)) return false;
	notify();
	return true;
}

export function hasMembershipOverlay(): boolean {
	return pendingLayers.size > 0;
}

export function subscribeMembership(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Latest membership patch for an id across every active operation. */
export function getVisibleMembership(id: string): MembershipPatch {
	const patch: MembershipPatch = {};
	for (const layer of pendingLayers.values()) {
		const entry = layer.get(id);
		if (!entry) continue;
		if (entry.status !== undefined) patch.status = entry.status;
		if (entry.folderId !== undefined) patch.folderId = entry.folderId;
		if (entry.snoozedUntil !== undefined) patch.snoozedUntil = entry.snoozedUntil;
		if (entry.starred !== undefined) patch.starred = entry.starred;
	}
	return patch;
}

/**
 * The state on screen before an undo starts. Prefer a tombstone because the
 * committed apply updates it with the server's applied state.
 */
export function captureVisibleMembership(ids: string[]): Map<string, MessageMembershipFields> {
	const captured = new Map<string, MessageMembershipFields>();
	for (const id of new Set(ids)) {
		const tombstone = tombstones.find((entry) => entry.row.id === id || entry.row.threadMessageIds?.includes(id));
		const known = tombstone?.row ?? knownRows.get(id);
		if (!known) continue;
		captured.set(id, { ...membershipFieldsOf(known), ...getVisibleMembership(id) });
	}
	return captured;
}

export function rememberRemovedRow(
	key: string,
	row: Message,
	removedIds: string[],
	index: number,
	offset: number,
	now = Date.now(),
): void {
	if (!key || removedIds.length === 0) return;
	pruneTombstones(now);
	const identity = rowIdentity(row);
	const existing = tombstones.find((entry) => entry.key === key && rowIdentity(entry.row) === identity);
	if (existing) {
		// A conversation loses one member at a time. Keep every captured member so
		// undoing the first removal can still find it after the second one.
		const previousMembers = existing.row.threadMessageIds;
		const nextMembers = row.threadMessageIds;
		const members = previousMembers?.length || nextMembers?.length
			? [...new Set([...(previousMembers ?? []), ...(nextMembers ?? [])])]
			: undefined;
		existing.row = members
			? {
				...row,
				threadMessageIds: members,
				threadCount: Math.max(existing.row.threadCount ?? 0, row.threadCount ?? 0, members.length),
			}
			: row;
		existing.removedIds = [...new Set([...existing.removedIds, ...removedIds])];
		existing.index = Math.min(existing.index, index);
		existing.offset = offset;
		existing.expiresAt = now + TOMBSTONE_TTL_MS;
		return;
	}
	tombstones.push({
		key,
		row,
		removedIds: [...new Set(removedIds)],
		index,
		offset,
		expiresAt: now + TOMBSTONE_TTL_MS,
	});
	if (tombstones.length > TOMBSTONE_LIMIT) tombstones = tombstones.slice(-TOMBSTONE_LIMIT);
}

/** Committed states replace the optimistic target stored with a tombstone. */
export function updateRemovedRows(states: MessageMembershipState[]): void {
	for (const state of states) {
		const fields = {
			status: state.status,
			folderId: state.folderId,
			snoozedUntil: state.snoozedUntil,
			starred: state.starred,
		};
		for (const entry of tombstones) {
			if (entry.row.id !== state.id && !entry.row.threadMessageIds?.includes(state.id)) continue;
			entry.row = { ...entry.row, ...fields };
		}
		const known = knownRows.get(state.id);
		if (known) knownRows.set(state.id, { ...known, ...fields });
	}
}

export function markRemovedRowsRestored(ids: string[]): void {
	for (const id of ids) restoredIds.add(id);
}

/** Whether an id has a tombstone that an optimistic restore could bring back. */
export function hasRemovedRow(id: string): boolean {
	return tombstones.some((entry) => entry.row.id === id || entry.row.threadMessageIds?.includes(id));
}

export function clearRestoredRows(ids: string[]): void {
	for (const id of ids) restoredIds.delete(id);
}

export function forgetRemovedRows(ids: string[]): void {
	const settled = new Set(ids);
	for (const id of settled) restoredIds.delete(id);
	tombstones = tombstones.flatMap((entry) => {
		const removedIds = entry.removedIds.filter((id) => !settled.has(id));
		if (removedIds.length === 0) return [];
		return [{ ...entry, removedIds }];
	});
}

/** Rows whose undo is in flight, ready to merge into any list view. */
export function getRestoredRowsForList(key: string, now = Date.now(), offset?: number): RestoredRow[] {
	pruneTombstones(now);
	const result: RestoredRow[] = [];
	for (const entry of tombstones) {
		if (entry.key !== key) continue;
		// A row belongs to the page it was removed from. Merging it into a
		// different page would paint it at the wrong place until the refetch.
		if (offset !== undefined && entry.offset !== offset) continue;
		const eligible = entry.removedIds.filter((id) => restoredIds.has(id));
		if (eligible.length === 0) continue;
		let row = entry.row;
		if (row.threadMessageIds?.length) {
			const keep = row.threadMessageIds.filter((id) => !entry.removedIds.includes(id) || restoredIds.has(id));
			if (keep.length === 0) continue;
			row = { ...row, threadMessageIds: keep, threadCount: keep.length };
		} else if (!restoredIds.has(row.id)) {
			continue;
		}
		// The tombstone carries the committed applied state. The active undo
		// overlay restores only the fields that action changed.
		const patch = row.threadMessageIds?.reduce<MembershipPatch>((current, id) => (
			Object.keys(current).length > 0 ? current : getVisibleMembership(id)
		), getVisibleMembership(row.id)) ?? getVisibleMembership(row.id);
		if (Object.keys(patch).length > 0) row = { ...row, ...patch };
		result.push({ row, index: entry.index, offset: entry.offset, eligible });
	}
	return result.sort((left, right) => left.index - right.index);
}

function filterPendingRow(
	row: Message,
	context: { folder: Parameters<typeof messageMatchesFolder>[1]; folderId?: string | null } | null,
	now: number,
): Message | null {
	if (!context) return row;
	const members = row.threadMessageIds;
	if (!members?.length) {
		const patch = getVisibleMembership(row.id);
		if (Object.keys(patch).length === 0) return row;
		return messageMatchesFolder({ ...membershipFieldsOf(row), ...patch }, context.folder, context.folderId, now) ? row : null;
	}
	const remaining = members.filter((id) => {
		const patch = getVisibleMembership(id);
		if (Object.keys(patch).length === 0) return true;
		return messageMatchesFolder({ ...membershipFieldsOf(row), ...patch }, context.folder, context.folderId, now);
	});
	if (remaining.length === members.length) return row;
	if (remaining.length === 0) return null;
	return { ...row, threadMessageIds: remaining };
}

function mergeRestoredRows(
	messages: Message[],
	restored: RestoredRow[],
): { messages: Message[]; added: number; membersAdded: number } {
	let added = 0;
	let membersAdded = 0;
	for (const restoredRow of restored) {
		const identity = rowIdentity(restoredRow.row);
		const existingIndex = messages.findIndex((message) => rowIdentity(message) === identity);
		if (existingIndex >= 0) {
			const current = messages[existingIndex];
			if (!current.threadMessageIds?.length) continue;
			const missing = restoredRow.eligible.filter((id) => !current.threadMessageIds?.includes(id));
			if (missing.length === 0) continue;
			messages[existingIndex] = {
				...current,
				threadMessageIds: [...current.threadMessageIds, ...missing],
				threadCount: (current.threadCount ?? current.threadMessageIds.length) + missing.length,
			};
			membersAdded += missing.length;
			continue;
		}
		const at = Math.min(Math.max(0, restoredRow.index), messages.length);
		messages.splice(at, 0, restoredRow.row);
		added += 1;
	}
	return { messages, added, membersAdded };
}

/**
 * Derives the membership-adjusted view of a raw list response. The cache keeps
 * the server totals, so repeated ingress is idempotent: hidden rows are counted
 * from the rows present, and restored rows are only added when missing.
 */
export function applyMembershipToList<T extends {
	messages?: Message[];
	total?: number;
	offset?: number;
}>(response: T, key: string, now = Date.now()): T {
	if (!response.messages) return response;
	const context = getListMembershipContext(key);
	const source = response.messages;
	const kept: Message[] = [];
	let hiddenRows = 0;
	let changedMembers = false;
	for (const row of source) {
		const filtered = filterPendingRow(row, context, now);
		if (filtered !== row) changedMembers = true;
		if (filtered) kept.push(filtered);
		else hiddenRows += 1;
	}
	const messages = [...kept];
	const restored = getRestoredRowsForList(getListMembershipKey(key), now, response.offset ?? 0);
	const merged = mergeRestoredRows(messages, restored);
	if (hiddenRows === 0 && merged.added === 0 && merged.membersAdded === 0 && !changedMembers) return response;
	return {
		...response,
		messages: merged.messages,
		total: Math.max(0, (response.total ?? source.length) - hiddenRows + merged.added),
	};
}

function pruneTombstones(now = Date.now()): void {
	tombstones = tombstones.filter((entry) => entry.expiresAt > now);
}

/** Test and session reset. */
export function clearMembershipState(): void {
	knownRows.clear();
	groupedMembers.clear();
	pendingLayers.clear();
	tombstones = [];
	restoredIds.clear();
	notify();
}

export function clearMembershipForTests(): void {
	clearMembershipState();
	listeners.clear();
}
