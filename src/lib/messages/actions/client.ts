"use client";

import { authFetch } from "@/lib/auth/client";
import { dispatchMessagesChanged, type MessageFieldPatch } from "@/lib/messages/change-events";
import { invalidateCachedMessageDetails, invalidateMessageDetailRequests, patchCachedMessageState, type CachedMessageStatePatch } from "@/lib/messages/detail-cache";
import {
	captureMessageFields,
	captureThreadUnread,
	clearPendingOverlay,
	forgetMessageFields,
	getPendingThreadTargets,
	getThreadRowIdsForMessages,
	getThreadUnreadTargets,
	invalidateThreadUnreadTargets,
	rememberThreadUnreadTargets,
	setPendingOverlay,
	type KnownMessageFields,
	type PendingOverlayMessage,
	type ThreadUnreadTarget,
} from "@/lib/messages/field-store";
import { clearMessageListCache, invalidateMessageListRequests, patchMessageFieldsInCaches } from "@/hooks/utils";
import { clearMessageThreadCache, invalidateMessageThreadRequests } from "@/components/messages/message-thread-cache";
import { getChangedStateFields } from "./definitions";
import {
	MessageActionExecutor,
	MessageActionRequestError,
	getChangedRecords,
	hasMembershipChange,
	type MessageActionExecutorHooks,
	type MessageActionHookContext,
	type MessageActionHookOptions,
	type MessageActionTransport,
} from "./executor";
import { showUndoToast } from "./undo-store";
import type {
	MessageActionInput,
	MessageActionRecord,
	MessageActionRequestOptions,
	MessageActionResponse,
	MessageActionTransportBody,
	UndoMessageActionResponse,
} from "./types";
import type { UndoToastEntry } from "./undo-store";

const DEFAULT_PENDING_OWNER = "message-action:direct";
const DEFAULT_MESSAGE_ACTION_TIMEOUT_MS = 30_000;
let messageActionTimeoutMs = DEFAULT_MESSAGE_ACTION_TIMEOUT_MS;

/** Test-only override so the bounded transport timeout needs no 30s wait. */
export function setMessageActionTransportTimeoutForTests(timeoutMs: number): void {
	messageActionTimeoutMs = Math.max(1, Math.trunc(timeoutMs));
}

async function sendMessageAction(
	body: MessageActionTransportBody,
): Promise<MessageActionResponse | UndoMessageActionResponse> {
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, messageActionTimeoutMs);
	try {
		const response = await authFetch("/api/messages/actions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		if (!response.ok) {
			throw new MessageActionRequestError(data.error ?? "Unable to update message", response.status);
		}
		return data as MessageActionResponse | UndoMessageActionResponse;
	} catch (error) {
		if (timedOut || (error instanceof Error && error.name === "AbortError")) {
			throw new MessageActionRequestError("The server did not respond in time", 408);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

/** Read/star fields changed by an action in the requested direction; membership stays server-first. */
function changedFieldPatches(
	records: MessageActionRecord[],
	direction: "previous" | "applied",
): PendingOverlayMessage[] {
	const fields: PendingOverlayMessage[] = [];
	for (const record of records) {
		const changed = new Set(getChangedStateFields(record.previous, record.applied));
		const entry: PendingOverlayMessage = { id: record.id };
		if (changed.has("read")) entry.read = record[direction].read;
		if (changed.has("starred")) entry.starred = record[direction].starred;
		if (entry.read !== undefined || entry.starred !== undefined) fields.push(entry);
	}
	return fields;
}

/** Pre-click values to restore when the server rejects or skips the undo. */
function capturedFieldPatches(
	records: MessageActionRecord[],
	captured: Map<string, KnownMessageFields>,
): PendingOverlayMessage[] {
	const fields: PendingOverlayMessage[] = [];
	for (const record of records) {
		const changed = new Set(getChangedStateFields(record.previous, record.applied));
		const known = captured.get(record.id);
		const entry: PendingOverlayMessage = { id: record.id };
		if (changed.has("read") && known?.read !== undefined) entry.read = known.read;
		if (changed.has("starred") && known?.starred !== undefined) entry.starred = known.starred;
		if (entry.read !== undefined || entry.starred !== undefined) fields.push(entry);
	}
	return fields;
}

function dispatchFieldChanges(fields: MessageFieldPatch[], threadTargets: ThreadUnreadTarget[]): void {
	const readGroups = new Map<boolean, string[]>();
	const starPatches: MessageFieldPatch[] = [];
	for (const field of fields) {
		if (field.read !== undefined) {
			const ids = readGroups.get(field.read) ?? [];
			ids.push(field.id);
			readGroups.set(field.read, ids);
		}
		if (field.starred !== undefined) starPatches.push({ id: field.id, starred: field.starred });
	}
	for (const [read, ids] of readGroups) {
		dispatchMessagesChanged({ kind: "read", messageIds: ids, read, threadTargets });
	}
	if (starPatches.length > 0) {
		dispatchMessagesChanged({ kind: "patch", patches: starPatches, threadTargets });
	}
}

/**
 * Patches caches then notifies consumers. Grouped rows get the absolute target
 * computed while patching, so a transition cannot apply twice.
 */
function applyFieldChanges(
	fields: PendingOverlayMessage[],
	threadTargets?: Map<string, number>,
): ThreadUnreadTarget[] {
	if (fields.length === 0 && !threadTargets?.size) return [];
	const targets = patchMessageFieldsInCaches(
		fields,
		threadTargets ? {
			threadTargets: [...threadTargets].map(([id, threadUnread]) => ({ id, threadUnread })),
		} : undefined,
	);
	if (fields.length > 0) dispatchFieldChanges(fields, targets);
	return targets;
}

function forgetUncapturedFields(
	records: MessageActionRecord[],
	captured: Map<string, KnownMessageFields>,
) {
	const readIds: string[] = [];
	const starredIds: string[] = [];
	for (const record of records) {
		const changed = new Set(getChangedStateFields(record.previous, record.applied));
		const known = captured.get(record.id);
		if (changed.has("read") && known?.read === undefined) readIds.push(record.id);
		if (changed.has("starred") && known?.starred === undefined) starredIds.push(record.id);
	}
	if (readIds.length > 0) forgetMessageFields(readIds, { read: true });
	if (starredIds.length > 0) forgetMessageFields(starredIds, { starred: true });
}

function commitWholeRollbackTargets(
	records: MessageActionRecord[],
	capturedThreads?: Map<string, number>,
): Map<string, number> {
	const rowIds = getThreadRowIdsForMessages(records.map((record) => record.id));
	const captured = capturedThreads ?? new Map<string, number>();
	rememberThreadUnreadTargets(captured);
	invalidateThreadUnreadTargets(rowIds.filter((rowId) => !captured.has(rowId)));
	return captured;
}

/**
 * Persists the settled aggregate even when its list row is no longer cached.
 * Partial rollbacks extend the pending target with only the skipped transitions.
 */
function commitSettledTargets(
	owner: string,
	records: MessageActionRecord[],
	restoredRecords: MessageActionRecord[],
	rollback: MessageActionRecord[],
	captured: Map<string, KnownMessageFields>,
	capturedThreads?: Map<string, number>,
): Map<string, number> {
	if (restoredRecords.length === 0) {
		return commitWholeRollbackTargets(records, capturedThreads);
	}
	const targets = new Map(getPendingThreadTargets(owner));
	for (const target of getThreadUnreadTargets(capturedFieldPatches(rollback, captured))) {
		targets.set(target.id, target.threadUnread);
	}
	const unknownReadIds = rollback
		.filter((record) => (
			getChangedStateFields(record.previous, record.applied).includes("read")
			&& captured.get(record.id)?.read === undefined
		))
		.map((record) => record.id);
	const unknownRows = getThreadRowIdsForMessages(unknownReadIds);
	for (const rowId of unknownRows) targets.delete(rowId);
	rememberThreadUnreadTargets(targets);
	invalidateThreadUnreadTargets(unknownRows);
	return targets;
}

function restoreCaptured(
	records: MessageActionRecord[],
	captured: Map<string, KnownMessageFields>,
	capturedThreads?: Map<string, number>,
) {
	forgetUncapturedFields(records, captured);
	const fields = capturedFieldPatches(records, captured);
	const hasReadChange = records.some((record) => (
		getChangedStateFields(record.previous, record.applied).includes("read")
	));
	applyFieldChanges(fields, hasReadChange ? capturedThreads : undefined);
}

function rememberDetailState(records: MessageActionRecord[], direction: "previous" | "applied") {
	for (const record of records) {
		const patch = Object.fromEntries(getChangedStateFields(record.previous, record.applied)
			.map((field) => [field, record[direction][field]])) as CachedMessageStatePatch;
		patchCachedMessageState(record.id, patch);
	}
}

/** Request invalidation without dropping a patched cache; one resync fetch follows. */
function invalidatePendingResponses(messageIds: string[]) {
	invalidateMessageListRequests();
	invalidateMessageThreadRequests();
	invalidateMessageDetailRequests(messageIds);
}

/** A timeout or dropped connection may still have committed server-side. */
function isUncertainActionFailure(error: unknown): boolean {
	if (error === undefined) return false;
	if (error instanceof MessageActionRequestError) {
		return error.status === 408 || error.status >= 500;
	}
	return true;
}

function invalidateUncertainState(messageIds: string[]) {
	clearMessageListCache();
	clearMessageThreadCache();
	invalidateCachedMessageDetails(messageIds);
	invalidatePendingResponses(messageIds);
}

export const defaultMessageActionHooks: MessageActionExecutorHooks = {
	onApplied(response: MessageActionResponse, options: MessageActionHookOptions, context?: MessageActionHookContext) {
		clearPendingOverlay(context?.pendingOwner ?? DEFAULT_PENDING_OWNER);
		const changed = getChangedRecords(response.applied);
		if (changed.length === 0) return;
		applyFieldChanges(changedFieldPatches(changed, "applied"));
		rememberDetailState(changed, "applied");
		if (options.notify && changed.some(hasMembershipChange)) dispatchMessagesChanged();
	},
	onApplyFailed(input, _options, context, error) {
		clearPendingOverlay(context?.pendingOwner ?? DEFAULT_PENDING_OWNER);
		if (!isUncertainActionFailure(error)) return;
		invalidateUncertainState(input.messageIds);
		dispatchMessagesChanged();
	},
	onUndoOptimistic(records, _captured, context) {
		const owner = context?.pendingOwner ?? DEFAULT_PENDING_OWNER;
		const fields = changedFieldPatches(records, "previous");
		if (fields.length === 0) return;
		// Patch caches, then overlay the same values on every ingress while pending.
		const targets = patchMessageFieldsInCaches(fields);
		setPendingOverlay(owner, { messages: fields, threads: targets });
		dispatchFieldChanges(fields, targets);
	},
	onUndoCompleted(records, response, captured, context) {
		// Skipped records return to the pre-click screen, not an older applied snapshot.
		const owner = context?.pendingOwner ?? DEFAULT_PENDING_OWNER;
		const restored = new Set(response.restored);
		const skipped = new Set(response.skipped.map((item) => item.id));
		const restoredRecords = records.filter((record) => restored.has(record.id));
		const skippedRecords = records.filter((record) => skipped.has(record.id));
		const unaccounted = records.filter((record) => !restored.has(record.id) && !skipped.has(record.id));
		const rollback = [...skippedRecords, ...unaccounted];
		// Commit the settled aggregate before dropping the owner, since a later
		// resync may clear every cached row before the next undo starts.
		const settledTargets = commitSettledTargets(owner, records, restoredRecords, rollback, captured, context?.capturedThreadUnread);
		clearPendingOverlay(owner);
		rememberDetailState(restoredRecords, "previous");
		// A mixed result keeps restored members; only skipped transitions roll back.
		restoreCaptured(rollback, captured, settledTargets);
		invalidateCachedMessageDetails(rollback.map((record) => record.id));
		invalidatePendingResponses(records.map((record) => record.id));
	},
	onUndoFailed(records, captured, context, error) {
		const owner = context?.pendingOwner ?? DEFAULT_PENDING_OWNER;
		const ids = records.map((record) => record.id);
		if (isUncertainActionFailure(error)) {
			clearPendingOverlay(owner);
			// The undo may have committed; let the resync fetch decide.
			forgetUncapturedFields(records, captured);
			invalidateThreadUnreadTargets(getThreadRowIdsForMessages(ids));
			invalidateUncertainState(ids);
			return;
		}
		const settledTargets = commitWholeRollbackTargets(records, context?.capturedThreadUnread);
		clearPendingOverlay(owner);
		restoreCaptured(records, captured, settledTargets);
		invalidateCachedMessageDetails(ids);
		invalidatePendingResponses(ids);
	},
	onResync() {
		dispatchMessagesChanged();
	},
	captureCurrent: captureMessageFields,
	captureThreadUnread,
};

export const messageActionExecutor = new MessageActionExecutor(sendMessageAction as MessageActionTransport, defaultMessageActionHooks);

/** Applies an explicit action and, unless suppressed, shows its independent undo toast. */
export async function performMessageAction(
	input: MessageActionInput,
	options: MessageActionRequestOptions = {},
): Promise<MessageActionResponse> {
	const response = await messageActionExecutor.run(input, { notify: options.notify });
	if (options.undo !== false) {
		const records = getChangedRecords(response.applied);
		showUndoToast({
			action: response.action,
			records,
			undoToken: response.undoToken,
			skipped: response.skipped.length,
		});
	}
	return response;
}

/** Undo runs through the same per-message queue as the action it reverts. */
export function undoMessageAction(entry: Pick<UndoToastEntry, "records" | "undoToken">) {
	return messageActionExecutor.undo(entry.records, entry.undoToken);
}

export { MessageActionRequestError };
