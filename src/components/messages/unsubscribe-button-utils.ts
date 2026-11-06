import { authFetch } from "@/lib/auth/client";
import type { UnsubscribeActionResult, UnsubscribePayload, UnsubscribePreviewResult, UnsubscribeResult } from "@/app/api/messages/[messageId]/unsubscribe/types";

export async function requestUnsubscribe(messageId: string, payload: UnsubscribePayload & { previewOnly: true }): Promise<UnsubscribePreviewResult>;
export async function requestUnsubscribe(messageId: string, payload?: UnsubscribePayload): Promise<UnsubscribeActionResult>;
export async function requestUnsubscribe(messageId: string, payload?: UnsubscribePayload): Promise<UnsubscribeResult> {
	const response = await authFetch(`/api/messages/${messageId}/unsubscribe`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload ?? {}),
	});
	const data = (await response.json()) as Partial<UnsubscribeResult> & { error?: string };
	if (!response.ok || !data.ok) throw new Error(data.error ?? "Unable to unsubscribe");
	return data as UnsubscribeResult;
}

export function describeUnsubscribeTrashSender(count: number): string {
	return `${count}`;
}
