import { authFetch } from "@/lib/auth/client";
import type { Message } from "@/hooks/types";
import type { CachedMessageDetail } from "./detail-cache-types";

const detailCache = new Map<string, CachedMessageDetail>();
const detailRequests = new Map<string, Promise<CachedMessageDetail>>();

export function clearMessageDetailCache() {
	detailCache.clear();
	detailRequests.clear();
}

export function getCachedMessageDetail(messageId: string): CachedMessageDetail | undefined {
	return detailCache.get(messageId);
}

export function setCachedMessageRead(messageId: string, read: boolean): void {
	const cached = detailCache.get(messageId);
	if (cached?.message) detailCache.set(messageId, { ...cached, message: { ...cached.message, read } });
}

export function primeMessageDetail(message: Message): void {
	if (message.textBody === undefined && message.htmlBody === undefined) return;
	detailCache.set(message.id, {
		message,
		body: { textBody: message.textBody ?? null, htmlBody: message.htmlBody ?? null },
		// Scheduled rows carry their send time; without it the reader skips the
		// scheduled-send banner (and Cancel send) because it trusts this cache.
		...(message.scheduledAt ? { scheduledAt: message.scheduledAt } : {}),
	});
}

export async function fetchCachedMessageDetail(messageId: string, force = false): Promise<CachedMessageDetail> {
	if (!force && detailCache.has(messageId)) return detailCache.get(messageId) ?? {};
	if (!force && detailRequests.has(messageId)) return detailRequests.get(messageId) ?? {};
	const request = authFetch(`/api/messages/${messageId}`)
		.then((response) => response.json() as Promise<CachedMessageDetail>)
		.then((data) => {
			detailCache.set(messageId, data);
			return data;
		})
		.finally(() => detailRequests.delete(messageId));
	detailRequests.set(messageId, request);
	return request;
}
