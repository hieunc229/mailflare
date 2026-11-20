import { authFetch } from "@/lib/auth/client";
import type { SubscriptionRowData, TrashPreview } from "./subscriptions-ui-types";

async function readJson<T>(response: Response): Promise<T> {
	const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
	if (!response.ok || !data) throw new Error(data?.error ?? `Request failed (${response.status})`);
	return data;
}

const post = (url: string, method: "POST" | "PUT", body: unknown) =>
	authFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function fetchSubscriptions(input: { mailboxId: string; offset: number; limit: number; signal?: AbortSignal }): Promise<{ senders: SubscriptionRowData[]; total: number }> {
	const params = new URLSearchParams({ mailboxId: input.mailboxId, offset: String(input.offset), limit: String(input.limit) });
	const data = await readJson<{ senders?: SubscriptionRowData[]; total?: number }>(await authFetch(`/api/subscriptions?${params}`, { signal: input.signal }));
	return { senders: data.senders ?? [], total: Number(data.total) || 0 };
}

/** `category: null` is "Automatic": the rule is removed and mail stays where it is. */
export async function saveSenderCategory(input: { mailboxId: string; senderAddress: string; category: "inbox" | "promotions" | null }): Promise<{ changed: number; remainingOlder: number }> {
	const data = await readJson<{ changed?: number; remainingOlder?: number }>(await post("/api/subscriptions/preference", "PUT", input));
	return { changed: Number(data.changed) || 0, remainingOlder: Number(data.remainingOlder) || 0 };
}

export async function previewSenderTrash(input: { mailboxId: string; senderAddress: string }): Promise<TrashPreview> {
	const data = await readJson<Partial<TrashPreview>>(await post("/api/subscriptions/trash", "POST", { ...input, previewOnly: true }));
	return { count: Number(data.count) || 0, willChange: Number(data.willChange) || 0, olderLeft: Number(data.olderLeft) || 0 };
}

export async function trashSender(input: { mailboxId: string; senderAddress: string }): Promise<{ changed: number; remaining: number }> {
	const data = await readJson<{ changed?: number; remaining?: number }>(await post("/api/subscriptions/trash", "POST", input));
	return { changed: Number(data.changed) || 0, remaining: Number(data.remaining) || 0 };
}
