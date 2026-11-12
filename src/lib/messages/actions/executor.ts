import { getChangedStateFields, recordHasChanges } from "./definitions";
import type {
	MessageActionInput,
	MessageActionRecord,
	MessageActionResponse,
	MessageActionTransportBody,
	MessageStateSnapshot,
	UndoMessageActionResponse,
} from "./types";

export class MessageActionRequestError extends Error {
	constructor(
		message: string,
		readonly status = 400,
		readonly skipped = 0,
	) {
		super(message);
		this.name = "MessageActionRequestError";
	}
}

export type MessageActionTransport = (
	body: MessageActionTransportBody,
) => Promise<MessageActionResponse | UndoMessageActionResponse>;

export type MessageActionHookOptions = { notify: boolean };

export type MessageActionExecutorHooks = {
	onApplyOptimistic?: (input: MessageActionInput, options: MessageActionHookOptions) => void;
	onApplyFailed?: (input: MessageActionInput, options: MessageActionHookOptions) => void;
	onApplied?: (response: MessageActionResponse, options: MessageActionHookOptions) => void;
	onUndoOptimistic?: (records: MessageActionRecord[]) => void;
	onUndoCompleted?: (records: MessageActionRecord[], response: UndoMessageActionResponse) => void;
	onUndoFailed?: (records: MessageActionRecord[]) => void;
	onResync?: () => void;
};

/**
 * Serializes actions per message id while letting unrelated messages proceed
 * in parallel. A second action on the same message (including an undo) waits
 * for the first response, so snapshots and UI patches cannot interleave.
 */
export class MessageActionExecutor {
	private readonly tails = new Map<string, Promise<void>>();

	constructor(
		private readonly transport: MessageActionTransport,
		private readonly hooks: MessageActionExecutorHooks = {},
	) {}

	async run(input: MessageActionInput, options: { notify?: boolean } = {}): Promise<MessageActionResponse> {
		return this.withLocks(input.messageIds, async () => {
			const hookOptions = { notify: options.notify !== false };
			this.hooks.onApplyOptimistic?.(input, hookOptions);
			let response: MessageActionResponse | UndoMessageActionResponse;
			try {
				response = await this.transport({ op: "apply", ...input });
			} catch (error) {
				this.hooks.onApplyFailed?.(input, hookOptions);
				throw error;
			}
			if (!response || response.ok !== true || !("applied" in response) || !Array.isArray(response.applied) || !Array.isArray(response.skipped)) {
				this.hooks.onApplyFailed?.(input, hookOptions);
				throw new MessageActionRequestError("Unable to update message", 502);
			}
			const result = response as MessageActionResponse;
			this.hooks.onApplied?.(result, hookOptions);
			if (result.applied.length === 0 && result.skipped.length > 0) {
				throw new MessageActionRequestError("No accessible messages", 404, result.skipped.length);
			}
			return result;
		});
	}

	async undo(records: MessageActionRecord[], token: string | undefined): Promise<UndoMessageActionResponse> {
		if (!token) throw new MessageActionRequestError("This undo has expired", 410);
		return this.withLocks(records.map((record) => record.id), async () => {
			this.hooks.onUndoOptimistic?.(records);
			try {
				const response = await this.transport({ op: "undo", token });
				if (!response || response.ok !== true || !Array.isArray((response as UndoMessageActionResponse).restored)) {
					throw new MessageActionRequestError("Could not undo that change", 502);
				}
				const result = response as UndoMessageActionResponse;
				this.hooks.onUndoCompleted?.(records, result);
				if (result.skipped.length > 0) this.hooks.onResync?.();
				return result;
			} catch (error) {
				this.hooks.onUndoFailed?.(records);
				this.hooks.onResync?.();
				throw error;
			}
		});
	}

	private withLocks<T>(ids: string[], task: () => Promise<T>): Promise<T> {
		const keys = [...new Set(ids)];
		const previous = keys
			.map((key) => this.tails.get(key))
			.filter((tail): tail is Promise<void> => !!tail);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = Promise.allSettled(previous).then(() => gate);
		for (const key of keys) this.tails.set(key, tail);

		return (async () => {
			await Promise.allSettled(previous);
			try {
				return await task();
			} finally {
				release();
				for (const key of keys) {
					if (this.tails.get(key) === tail) this.tails.delete(key);
				}
			}
		})();
	}
}

export function getChangedRecords(records: MessageActionRecord[]): MessageActionRecord[] {
	return records.filter(recordHasChanges);
}

export function readPatchGroups(records: MessageActionRecord[], direction: "previous" | "applied") {
	const groups = new Map<boolean, string[]>();
	for (const record of records) {
		if (record.previous.read === record.applied.read) continue;
		const read = record[direction].read;
		const ids = groups.get(read) ?? [];
		ids.push(record.id);
		groups.set(read, ids);
	}
	return groups;
}

export function starPatchGroups(records: MessageActionRecord[], direction: "previous" | "applied") {
	const groups = new Map<boolean, string[]>();
	for (const record of records) {
		if (record.previous.starred === record.applied.starred) continue;
		const starred = record[direction].starred;
		const ids = groups.get(starred) ?? [];
		ids.push(record.id);
		groups.set(starred, ids);
	}
	return groups;
}

export function hasMembershipChange(record: MessageActionRecord): boolean {
	return getChangedStateFields(record.previous, record.applied)
		.some((field) => field === "status" || field === "folderId" || field === "snoozedUntil");
}

export function restoreSnapshots(
	records: MessageActionRecord[],
	state: (record: MessageActionRecord) => MessageStateSnapshot,
) {
	return records.map((record) => ({ ...record, applied: state(record) }));
}
