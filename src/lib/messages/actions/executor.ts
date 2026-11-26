import { getChangedStateFields, recordHasChanges } from "./definitions";
import { getConversationLockKeys, type KnownMessageFields } from "@/lib/messages/field-store";
import type { MessageMembershipFields } from "@/lib/messages/list-membership";
import type {
	MessageActionInput,
	MessageActionRecord,
	MessageActionResponse,
	MessageActionTransportBody,
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

export type MessageActionHookContext = {
	/** Unique owner key for the pending overlay written by this operation. */
	pendingOwner: string;
	/** Grouped unread aggregates captured before the optimistic patch. */
	capturedThreadUnread?: Map<string, number>;
	/** Membership on screen before an optimistic undo. */
	capturedMembership?: Map<string, MessageMembershipFields>;
};

export type MessageActionExecutorHooks = {
	onApplyOptimistic?: (input: MessageActionInput, options: MessageActionHookOptions, context: MessageActionHookContext) => void;
	onApplyFailed?: (input: MessageActionInput, options: MessageActionHookOptions, context: MessageActionHookContext, error: unknown) => void;
	onApplied?: (response: MessageActionResponse, options: MessageActionHookOptions, context: MessageActionHookContext) => void;
	/** Snapshots the tab's current read/star values before an optimistic undo patch. */
	captureCurrent?: (ids: string[]) => Map<string, KnownMessageFields>;
	/** Snapshots grouped unread aggregates before an optimistic undo patch. */
	captureThreadUnread?: (ids: string[]) => Map<string, number>;
	/** Snapshots the visible membership before an optimistic undo patch. */
	captureMembership?: (ids: string[]) => Map<string, MessageMembershipFields>;
	onUndoOptimistic?: (records: MessageActionRecord[], captured: Map<string, KnownMessageFields>, context: MessageActionHookContext) => void;
	onUndoCompleted?: (records: MessageActionRecord[], response: UndoMessageActionResponse, captured: Map<string, KnownMessageFields>, context: MessageActionHookContext) => void;
	onUndoFailed?: (records: MessageActionRecord[], captured: Map<string, KnownMessageFields>, context: MessageActionHookContext, error: unknown) => void;
	onResync?: (messageIds: string[]) => void;
};

/**
 * Serializes actions per message id, extended to the whole known conversation.
 * A second action on any member (including an undo) waits for the first
 * response, so grouped aggregate snapshots and optimistic targets cannot
 * overlap. Actions in unrelated conversations still proceed in parallel.
 */
export class MessageActionExecutor {
	private readonly tails = new Map<string, Promise<void>>();
	private nextOperationId = 0;

	constructor(
		private readonly transport: MessageActionTransport,
		private readonly hooks: MessageActionExecutorHooks = {},
	) {}

	async run(input: MessageActionInput, options: { notify?: boolean } = {}): Promise<MessageActionResponse> {
		return this.withLocks(input.messageIds, async () => {
			const hookOptions = { notify: options.notify !== false };
			const context = { pendingOwner: `message-action:apply:${++this.nextOperationId}` };
			this.hooks.onApplyOptimistic?.(input, hookOptions, context);
			let response: MessageActionResponse | UndoMessageActionResponse;
			try {
				response = await this.transport({ op: "apply", ...input });
			} catch (error) {
				this.hooks.onApplyFailed?.(input, hookOptions, context, error);
				throw error;
			}
			if (!response || response.ok !== true || !("applied" in response) || !Array.isArray(response.applied) || !Array.isArray(response.skipped)) {
				const failure = new MessageActionRequestError("Unable to update message", 502);
				this.hooks.onApplyFailed?.(input, hookOptions, context, failure);
				throw failure;
			}
			const result = response as MessageActionResponse;
			this.hooks.onApplied?.(result, hookOptions, context);
			if (result.applied.length === 0 && result.skipped.length > 0) {
				throw new MessageActionRequestError("No accessible messages", 404, result.skipped.length);
			}
			return result;
		});
	}

	async undo(records: MessageActionRecord[], token: string | undefined): Promise<UndoMessageActionResponse> {
		if (!token) throw new MessageActionRequestError("This undo has expired", 410);
		const ids = records.map((record) => record.id);
		return this.withLocks(ids, async () => {
			const captured = this.hooks.captureCurrent?.(ids) ?? new Map<string, KnownMessageFields>();
			const capturedThreadUnread = this.hooks.captureThreadUnread?.(ids);
			const capturedMembership = this.hooks.captureMembership?.(ids);
			const context = {
				pendingOwner: `message-action:undo:${++this.nextOperationId}`,
				capturedThreadUnread,
				capturedMembership,
			};
			this.hooks.onUndoOptimistic?.(records, captured, context);
			try {
				const response = await this.transport({ op: "undo", token });
				if (!response || response.ok !== true || !Array.isArray((response as UndoMessageActionResponse).restored)) {
					throw new MessageActionRequestError("Could not undo that change", 502);
				}
				const result = response as UndoMessageActionResponse;
				this.hooks.onUndoCompleted?.(records, result, captured, context);
				this.hooks.onResync?.(ids);
				return result;
			} catch (error) {
				this.hooks.onUndoFailed?.(records, captured, context, error);
				this.hooks.onResync?.(ids);
				throw error;
			}
		});
	}

	private withLocks<T>(ids: string[], task: () => Promise<T>): Promise<T> {
		const keys = getConversationLockKeys(ids);
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

export function hasMembershipChange(record: MessageActionRecord): boolean {
	return getChangedStateFields(record.previous, record.applied)
		.some((field) => field === "status" || field === "folderId" || field === "snoozedUntil");
}
