"use client";

import { authFetch } from "@/lib/auth/client";
import { dispatchMessagesChanged, type MessageFieldPatch } from "@/lib/messages/change-events";
import { invalidateCachedMessageDetails } from "@/lib/messages/detail-cache";
import { captureMessageFields, type KnownMessageFields } from "@/lib/messages/field-store";
import { patchMessagesInCaches } from "@/hooks/utils";
import {
	MessageActionExecutor,
	MessageActionRequestError,
	getChangedRecords,
	hasMembershipChange,
	readPatchGroups,
	starPatchGroups,
	type MessageActionExecutorHooks,
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

async function sendMessageAction(
	body: MessageActionTransportBody,
): Promise<MessageActionResponse | UndoMessageActionResponse> {
	const response = await authFetch("/api/messages/actions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await response.json().catch(() => ({}))) as { error?: string };
	if (!response.ok) {
		throw new MessageActionRequestError(data.error ?? "Unable to update message", response.status);
	}
	return data as MessageActionResponse | UndoMessageActionResponse;
}

/**
 * Patches the caches and tells every mounted list/thread which ids changed.
 * `deferRefresh` keeps the optimistic value on screen until the request that
 * produced it settles; without it the consumers quietly re-read the server.
 */
function dispatchRead(ids: string[], read: boolean, deferRefresh: boolean) {
	if (ids.length === 0) return;
	patchMessagesInCaches(ids, { read });
	dispatchMessagesChanged({ kind: "read", messageIds: ids, read, deferRefresh });
}

function dispatchStarGroups(groups: Map<boolean, string[]>, deferRefresh: boolean) {
	if (groups.size === 0) return;
	const patches: MessageFieldPatch[] = [];
	for (const [starred, ids] of groups) {
		if (ids.length === 0) continue;
		patchMessagesInCaches(ids, { starred });
		for (const id of ids) patches.push({ id, starred });
	}
	if (patches.length > 0) dispatchMessagesChanged({ kind: "patch", patches, deferRefresh });
}

function capturedPatches(
	records: MessageActionRecord[],
	captured: Map<string, KnownMessageFields>,
) {
	const readGroups = new Map<boolean, string[]>();
	const starGroups = new Map<boolean, string[]>();
	for (const record of records) {
		const known = captured.get(record.id);
		if (known?.read !== undefined && record.previous.read !== record.applied.read) {
			const ids = readGroups.get(known.read) ?? [];
			ids.push(record.id);
			readGroups.set(known.read, ids);
		}
		if (known?.starred !== undefined && record.previous.starred !== record.applied.starred) {
			const ids = starGroups.get(known.starred) ?? [];
			ids.push(record.id);
			starGroups.set(known.starred, ids);
		}
	}
	return { readGroups, starGroups };
}

function restoreCaptured(
	records: MessageActionRecord[],
	captured: Map<string, KnownMessageFields>,
) {
	const { readGroups, starGroups } = capturedPatches(records, captured);
	for (const [read, ids] of readGroups) dispatchRead(ids, read, true);
	dispatchStarGroups(starGroups, true);
}

export const defaultMessageActionHooks: MessageActionExecutorHooks = {
	onApplied(response: MessageActionResponse, options: MessageActionHookOptions) {
		const changed = getChangedRecords(response.applied);
		if (changed.length === 0) return;
		const deferRefresh = !options.notify;
		for (const [read, ids] of readPatchGroups(changed, "applied")) dispatchRead(ids, read, deferRefresh);
		dispatchStarGroups(starPatchGroups(changed, "applied"), deferRefresh);
		if (options.notify && changed.some(hasMembershipChange)) dispatchMessagesChanged();
	},
	onUndoOptimistic(records) {
		for (const [read, ids] of readPatchGroups(records, "previous")) dispatchRead(ids, read, true);
		dispatchStarGroups(starPatchGroups(records, "previous"), true);
	},
	onUndoCompleted(records, response, captured) {
		// The optimistic patches already show the restored state. Records the
		// server skipped must return to what was on screen before the undo click,
		// not an older action's historical applied snapshot.
		const skipped = new Set(response.skipped.map((item) => item.id));
		restoreCaptured(records.filter((record) => skipped.has(record.id)), captured);
	},
	onUndoFailed(records, captured) {
		restoreCaptured(records, captured);
	},
	onResync(messageIds) {
		invalidateCachedMessageDetails(messageIds);
		dispatchMessagesChanged();
	},
	captureCurrent: captureMessageFields,
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
