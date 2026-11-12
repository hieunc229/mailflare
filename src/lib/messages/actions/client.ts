"use client";

import { authFetch } from "@/lib/auth/client";
import { dispatchMessagesChanged } from "@/lib/messages/change-events";
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

function dispatchRead(ids: string[], read: boolean) {
	if (ids.length === 0) return;
	patchMessagesInCaches(ids, { read });
	dispatchMessagesChanged({ kind: "read", messageIds: ids, read });
}

const defaultHooks: MessageActionExecutorHooks = {
	onApplied(response: MessageActionResponse, options: MessageActionHookOptions) {
		const changed = getChangedRecords(response.applied);
		if (changed.length === 0) return;
		for (const [read, ids] of readPatchGroups(changed, "applied")) {
			patchMessagesInCaches(ids, { read });
			if (options.notify) dispatchMessagesChanged({ kind: "read", messageIds: ids, read });
		}
		const starred = starPatchGroups(changed, "applied");
		for (const [value, ids] of starred) patchMessagesInCaches(ids, { starred: value });
		if (options.notify && (starred.size > 0 || changed.some(hasMembershipChange))) dispatchMessagesChanged();
	},
	onUndoOptimistic(records) {
		// Read/unread undo must feel immediate; other fields stay server-first.
		for (const [read, ids] of readPatchGroups(records, "previous")) dispatchRead(ids, read);
	},
	onUndoCompleted(records, response) {
		const restoredSet = new Set(response.restored);
		const restored = records.filter((record) => restoredSet.has(record.id));
		for (const [read, ids] of readPatchGroups(restored, "previous")) dispatchRead(ids, read);
		const starred = starPatchGroups(restored, "previous");
		for (const [value, ids] of starred) patchMessagesInCaches(ids, { starred: value });
		if (starred.size > 0 || restored.some(hasMembershipChange) || response.skipped.length > 0) {
			dispatchMessagesChanged();
		}
	},
	onUndoFailed(records) {
		// Roll the optimistic read patch back to what the failed action wrote.
		for (const [read, ids] of readPatchGroups(records, "applied")) dispatchRead(ids, read);
		for (const [value, ids] of starPatchGroups(records, "applied")) patchMessagesInCaches(ids, { starred: value });
		dispatchMessagesChanged();
	},
	onResync() {
		dispatchMessagesChanged();
	},
};

export const messageActionExecutor = new MessageActionExecutor(sendMessageAction as MessageActionTransport, defaultHooks);

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
