import { authFetch } from "@/lib/auth/client";
import type { UnsubscribeResult } from "@/app/api/messages/[messageId]/unsubscribe/types";

export async function requestUnsubscribe(messageId: string): Promise<UnsubscribeResult> {
	const response = await authFetch(`/api/messages/${messageId}/unsubscribe`, { method: "POST" });
	const data = (await response.json()) as Partial<UnsubscribeResult> & { error?: string };
	if (!response.ok || !data.ok || !data.method) throw new Error(data.error ?? "Unable to unsubscribe");
	return data as UnsubscribeResult;
}
