"use client";

import { showPromotionToast, updatePromotionToast } from "@/components/messages/promotion-toast-store";
import { authFetch } from "@/lib/auth/client";
import { invalidateCachedMessageDetails } from "@/lib/messages/detail-cache";
import { dispatchMessagesChanged } from "@/lib/messages/change-events";
import {
	canOfferAlways,
	moveToastCopy,
	runLimited,
	senderResultCopy,
	summarizeMoves,
	type MoveSummary,
	type MoveTarget,
} from "./move-utils";

/** Conversation rows move one request per message; four at a time keeps a long thread from flooding the Worker. */
export const MOVE_CONCURRENCY = 4;

type CategoryResult = { changed: number; remainingOlder: number };

export type MoveInput = {
	messageIds: string[];
	target: MoveTarget;
	mailboxId: string | null;
	/** The row's sender, for the "Always for ..." offer; null hides it. */
	senderAddress: string | null | undefined;
};

async function readResult(response: Response): Promise<CategoryResult> {
	const data = (await response.json().catch(() => null)) as Partial<CategoryResult> & { error?: string } | null;
	if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status})`);
	return { changed: Number(data?.changed) || 0, remainingOlder: Number(data?.remainingOlder) || 0 };
}

async function patchCategory(messageId: string, target: MoveTarget): Promise<CategoryResult> {
	const response = await authFetch(`/api/messages/${messageId}/category`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ category: target }),
	});
	return readResult(response);
}

/** Lists and counts are refetched, never patched: the server decides which folder a message belongs to. */
function refreshMessages(messageIds: string[]) {
	invalidateCachedMessageDetails(messageIds);
	dispatchMessagesChanged();
}

/** Moves every message of a row, tells the user what happened, and offers a per-sender rule after a clean move. */
export async function moveMessagesToCategory(input: MoveInput): Promise<MoveSummary> {
	const results = await runLimited(input.messageIds, MOVE_CONCURRENCY, (id) => patchCategory(id, input.target));
	const summary = summarizeMoves(results);
	if (summary.moved > 0) refreshMessages(input.messageIds);
	const offer = input.mailboxId && input.senderAddress && canOfferAlways(summary, input.senderAddress)
		? { mailboxId: input.mailboxId, senderAddress: input.senderAddress, target: input.target, working: false }
		: undefined;
	showPromotionToast({ copy: moveToastCopy(input.target, summary), tone: summary.moved === 0 ? "error" : summary.failed > 0 ? "warn" : "ok", always: offer });
	return summary;
}

/** PUT the sender rule, then report the bounded re-file ("Moved N; M older were left"). */
export async function applyAlwaysForSender(toastId: number, rule: { mailboxId: string; senderAddress: string; target: MoveTarget }): Promise<void> {
	updatePromotionToast(toastId, { always: { ...rule, working: true } });
	try {
		const response = await authFetch("/api/subscriptions/preference", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mailboxId: rule.mailboxId, senderAddress: rule.senderAddress, category: rule.target }),
		});
		const result = await readResult(response);
		dispatchMessagesChanged();
		updatePromotionToast(toastId, { copy: senderResultCopy(result), tone: "ok", always: undefined });
	} catch {
		updatePromotionToast(toastId, { copy: { key: "promotions.always.failed" }, tone: "error", always: { ...rule, working: false } });
	}
}
