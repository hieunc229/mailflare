/**
 * The latest read/star values this tab has seen per message, so undo snapshots
 * the screen rather than an older action's "applied" state. A pending overlay
 * sits on top while its request is in flight and every cache ingress applies it.
 */
export type KnownMessageFields = {
	read?: boolean;
	starred?: boolean;
};

export type PendingOverlayMessage = KnownMessageFields & {
	id: string;
};

/** Absolute unread target for a grouped conversation row. */
export type ThreadUnreadTarget = {
	id: string;
	threadUnread: number;
};

export type PendingOverlayEntries = {
	messages?: PendingOverlayMessage[];
	threads?: ThreadUnreadTarget[];
};

type KnownThread = {
	messageIds: string[];
	/** Absent while the aggregate is unknown and awaiting an authoritative row. */
	threadUnread?: number;
};

type PendingLayer = {
	messages: Map<string, KnownMessageFields>;
	threads: Map<string, number>;
};

type PendingRow = {
	id: string;
	read?: boolean;
	starred?: boolean;
	threadMessageIds?: string[];
	threadUnread?: number;
};

const knownFields = new Map<string, KnownMessageFields>();
const knownThreads = new Map<string, KnownThread>();
const pendingLayers = new Map<string, PendingLayer>();
const pendingListeners = new Set<() => void>();

function clampCount(value: number, size: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(size, Math.max(0, Math.trunc(value)));
}

function notifyPendingListeners(): void {
	for (const listener of [...pendingListeners]) listener();
}

export function rememberMessageFields(messageIds: string[], patch: KnownMessageFields): void {
	if (patch.read === undefined && patch.starred === undefined) return;
	for (const id of messageIds) {
		const current = knownFields.get(id) ?? {};
		knownFields.set(id, {
			...current,
			...(patch.read !== undefined ? { read: patch.read } : {}),
			...(patch.starred !== undefined ? { starred: patch.starred } : {}),
		});
	}
}

/** Drops optimistic member state when a rollback has no trusted snapshot. */
export function forgetMessageFields(messageIds: string[], fields: KnownMessageFields): void {
	for (const id of messageIds) {
		const current = knownFields.get(id);
		if (!current) continue;
		if (fields.read) delete current.read;
		if (fields.starred) delete current.starred;
		if (current.read === undefined && current.starred === undefined) knownFields.delete(id);
	}
}

export function rememberMessageRows(rows: PendingRow[]): void {
	for (const row of rows) {
		const grouped = !!row.threadMessageIds?.length;
		if ((row.read !== undefined && !grouped) || row.starred !== undefined) {
			rememberMessageFields([row.id], {
				// A grouped row's read flag is an aggregate, not the anchor's own state.
				...(row.read !== undefined && !grouped ? { read: row.read } : {}),
				...(row.starred !== undefined ? { starred: row.starred } : {}),
			});
		}
		if (row.threadMessageIds?.length) {
			const messageIds = [...new Set(row.threadMessageIds)];
			knownThreads.set(row.id, {
				messageIds,
				threadUnread: clampCount(row.threadUnread ?? 0, messageIds.length),
			});
		}
	}
}

/** Any action touching a member of a known conversation joins one lock group. */
export function getConversationLockKeys(ids: string[]): string[] {
	const keys = new Set(ids);
	for (const [rowId, row] of knownThreads) {
		if (!keys.has(rowId) && !row.messageIds.some((id) => keys.has(id))) continue;
		keys.add(rowId);
		for (const id of row.messageIds) keys.add(id);
	}
	return [...keys];
}

/** Grouped rows containing any of these message ids. */
export function getThreadRowIdsForMessages(ids: string[]): string[] {
	const messageIds = new Set(ids);
	if (messageIds.size === 0) return [];
	const rowIds: string[] = [];
	for (const [rowId, row] of knownThreads) {
		if (row.messageIds.some((id) => messageIds.has(id))) rowIds.push(rowId);
	}
	return rowIds;
}

/** Persists a server-confirmed aggregate even when its list row is not cached. */
export function rememberThreadUnreadTargets(targets: Map<string, number>): void {
	for (const [rowId, threadUnread] of targets) {
		const row = knownThreads.get(rowId);
		if (!row || !Number.isFinite(threadUnread)) continue;
		row.threadUnread = clampCount(threadUnread, row.messageIds.length);
	}
}

/** Keeps conversation membership for locking but drops an untrusted aggregate. */
export function invalidateThreadUnreadTargets(rowIds: string[]): void {
	for (const rowId of rowIds) {
		const row = knownThreads.get(rowId);
		if (row) row.threadUnread = undefined;
	}
}

function pendingFieldsFor(messageId: string): KnownMessageFields {
	const fields: KnownMessageFields = {};
	for (const layer of pendingLayers.values()) {
		const pending = layer.messages.get(messageId);
		if (!pending) continue;
		if (pending.read !== undefined) fields.read = pending.read;
		if (pending.starred !== undefined) fields.starred = pending.starred;
	}
	return fields;
}

function pendingThreadUnreadFor(rowId: string): number | undefined {
	let threadUnread: number | undefined;
	for (const layer of pendingLayers.values()) {
		const target = layer.threads.get(rowId);
		if (target !== undefined) threadUnread = target;
	}
	return threadUnread;
}

export function getPendingThreadTargets(owner: string): Map<string, number> {
	return new Map(pendingLayers.get(owner)?.threads ?? []);
}

/** Latest known value including any active pending operation. */
export function getVisibleMessageFields(messageId: string): KnownMessageFields {
	return { ...(knownFields.get(messageId) ?? {}), ...pendingFieldsFor(messageId) };
}

/** Latest visible unread aggregate for a grouped conversation row. */
export function getKnownThreadUnread(rowId: string): number | undefined {
	const pending = pendingThreadUnreadFor(rowId);
	if (pending !== undefined) return pending;
	return knownThreads.get(rowId)?.threadUnread;
}

/** Applies every active owner's overlay; later owners win field by field. */
export function applyPendingToMessage<T extends PendingRow>(message: T): T {
	let read = message.read;
	let starred = message.starred;
	let threadUnread = message.threadUnread;
	let changed = false;

	for (const layer of pendingLayers.values()) {
		const fields = layer.messages.get(message.id);
		if (fields?.read !== undefined && read !== fields.read) {
			read = fields.read;
			changed = true;
		}
		if (fields?.starred !== undefined && starred !== fields.starred) {
			starred = fields.starred;
			changed = true;
		}
		const target = layer.threads.get(message.id);
		if (target !== undefined && message.threadMessageIds?.length) {
			const nextUnread = clampCount(target, message.threadMessageIds.length);
			if (threadUnread !== nextUnread) {
				threadUnread = nextUnread;
				changed = true;
			}
		}
	}

	if (!changed) return message;
	const next = { ...message } as T;
	if (message.read !== undefined || read !== undefined) next.read = read;
	if (message.starred !== undefined || starred !== undefined) next.starred = starred;
	if (threadUnread !== undefined) {
		next.threadUnread = threadUnread;
		if (message.threadMessageIds?.length) next.read = threadUnread === 0;
	}
	return next;
}

export function applyPendingToMessages<T extends PendingRow>(messages: T[]): T[] {
	let changed = false;
	const next = messages.map((message) => {
		const applied = applyPendingToMessage(message);
		if (applied !== message) changed = true;
		return applied;
	});
	return changed ? next : messages;
}

export function applyPendingToMessageList<T extends { messages?: PendingRow[] }>(response: T): T {
	if (!response.messages?.length) return response;
	const messages = applyPendingToMessages(response.messages);
	return messages === response.messages ? response : { ...response, messages };
}

export function setPendingOverlay(owner: string, entries: PendingOverlayEntries): void {
	if (!owner) return;
	const messages = new Map<string, KnownMessageFields>();
	for (const entry of entries.messages ?? []) {
		if (entry.read === undefined && entry.starred === undefined) continue;
		const fields = messages.get(entry.id) ?? {};
		if (entry.read !== undefined) fields.read = entry.read;
		if (entry.starred !== undefined) fields.starred = entry.starred;
		messages.set(entry.id, fields);
	}
	const threads = new Map<string, number>();
	for (const entry of entries.threads ?? []) {
		if (!Number.isFinite(entry.threadUnread)) continue;
		threads.set(entry.id, Math.max(0, Math.trunc(entry.threadUnread)));
	}
	if (messages.size === 0 && threads.size === 0) {
		clearPendingOverlay(owner);
		return;
	}
	// An existing owner keeps its map position, so a newer operation stays last.
	pendingLayers.set(owner, { messages, threads });
	notifyPendingListeners();
}

export function clearPendingOverlay(owner: string): boolean {
	if (!pendingLayers.delete(owner)) return false;
	notifyPendingListeners();
	return true;
}

export function hasPendingOverlay(): boolean {
	return pendingLayers.size > 0;
}

export function getPendingOverlayOwners(): string[] {
	return [...pendingLayers.keys()];
}

export function subscribePendingOverlay(listener: () => void): () => void {
	pendingListeners.add(listener);
	return () => pendingListeners.delete(listener);
}

/** Absolute unread targets: only real member transitions, bounded by the aggregate. */
export function getThreadUnreadTargets(fields: PendingOverlayMessage[]): ThreadUnreadTarget[] {
	const reads = new Map<string, boolean>();
	for (const field of fields) {
		if (field.read !== undefined) reads.set(field.id, field.read);
	}
	if (reads.size === 0) return [];

	const targets: ThreadUnreadTarget[] = [];
	for (const [rowId, row] of knownThreads) {
		if (!row.messageIds.some((id) => reads.has(id))) continue;
		const visibleAggregate = getKnownThreadUnread(rowId);
		if (visibleAggregate === undefined) continue;
		const currentUnread = clampCount(visibleAggregate, row.messageIds.length);
		let directToRead = 0;
		let directToUnread = 0;
		let unknownUnread = 0;
		let unknownRead = 0;
		let knownUnread = 0;
		let knownRead = 0;

		for (const id of row.messageIds) {
			const visible = getVisibleMessageFields(id).read;
			if (visible === false) knownUnread += 1;
			if (visible === true) knownRead += 1;
			const desired = reads.get(id);
			if (desired === undefined) continue;
			if (visible === undefined) {
				if (desired) unknownUnread += 1;
				else unknownRead += 1;
			} else if (visible !== desired) {
				if (desired) directToRead += 1;
				else directToUnread += 1;
			}
		}

		const unknownUnreadAvailable = Math.max(0, currentUnread - knownUnread);
		const unknownReadAvailable = Math.max(0, row.messageIds.length - currentUnread - knownRead);
		const toRead = directToRead + Math.min(unknownUnread, unknownUnreadAvailable);
		const toUnread = directToUnread + Math.min(unknownRead, unknownReadAvailable);
		const target = clampCount(currentUnread - toRead + toUnread, row.messageIds.length);
		targets.push({ id: rowId, threadUnread: target });
	}
	return targets;
}

/** Pre-click grouped unread aggregates for rollback after a failed undo. */
export function captureThreadUnread(ids: string[]): Map<string, number> {
	const messageIds = new Set(ids);
	const captured = new Map<string, number>();
	for (const [rowId, row] of knownThreads) {
		if (!row.messageIds.some((id) => messageIds.has(id))) continue;
		const visible = getKnownThreadUnread(rowId);
		if (visible !== undefined) captured.set(rowId, clampCount(visible, row.messageIds.length));
	}
	return captured;
}

/** Copies only fields this tab has actually observed; unknown ids stay unknown. */
export function captureMessageFields(ids: string[]): Map<string, KnownMessageFields> {
	const captured = new Map<string, KnownMessageFields>();
	for (const id of new Set(ids)) {
		const fields = getVisibleMessageFields(id);
		if (fields.read !== undefined || fields.starred !== undefined) captured.set(id, fields);
	}
	return captured;
}

/** Test-only reset. */
export function clearKnownMessageFieldsForTests(): void {
	knownFields.clear();
	knownThreads.clear();
	pendingLayers.clear();
}
