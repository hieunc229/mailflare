import { AUTH_SESSION_CHANGED_EVENT, authFetch } from "@/lib/auth/client";
import { applyPendingToMessage, rememberMessageFields } from "@/lib/messages/field-store";
import type { Message } from "@/hooks/types";
import type { CachedMessageDetail } from "./detail-cache-types";

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 50;
const detailCache = new Map<string, { data: CachedMessageDetail; expiresAt: number }>();
const detailRequests = new Map<string, Promise<CachedMessageDetail>>();
/** Per-message invalidation marker for requests that started before an undo settled. */
const detailRevisions = new Map<string, number>();
/** Per-message mutation marker for a completed read/star/membership change. */
const stateRevisions = new Map<string, number>();
let generation = 0;

function bumpStateRevision(messageId: string): void {
	stateRevisions.set(messageId, (stateRevisions.get(messageId) ?? 0) + 1);
}

/** Keep a completed local field change over a detail response that started before it. */
function preserveNewerState(messageId: string, data: CachedMessageDetail): CachedMessageDetail {
	if (!data.message) return data;
	const current = detailCache.get(messageId)?.data.message;
	if (!current) return data;
	return {
		...data,
		message: {
			...data.message,
			read: current.read,
			starred: current.starred,
			status: current.status,
			folderId: current.folderId,
			snoozedUntil: current.snoozedUntil,
		},
	};
}

function applyPendingDetail(data: CachedMessageDetail): CachedMessageDetail {
	if (!data.message) return data;
	const message = applyPendingToMessage(data.message);
	return message === data.message ? data : { ...data, message };
}

function cacheDetail(messageId: string, data: CachedMessageDetail) {
	const nextData = applyPendingDetail(data);
	detailCache.delete(messageId);
	detailCache.set(messageId, { data: nextData, expiresAt: Date.now() + CACHE_TTL_MS });
	if (nextData.message) rememberMessageFields([messageId], { read: nextData.message.read, starred: nextData.message.starred });
	if (detailCache.size > CACHE_LIMIT) {
		const oldest = detailCache.keys().next().value;
		if (oldest) detailCache.delete(oldest);
	}
}

export function clearMessageDetailCache() {
	generation += 1;
	detailCache.clear();
	detailRequests.clear();
	detailRevisions.clear();
	stateRevisions.clear();
}

export function getCachedMessageDetail(messageId: string): CachedMessageDetail | undefined {
	const cached = detailCache.get(messageId);
	if (!cached) return undefined;
	if (cached.expiresAt <= Date.now()) {
		detailCache.delete(messageId);
		return undefined;
	}
	detailCache.delete(messageId);
	detailCache.set(messageId, cached);
	return applyPendingDetail(cached.data);
}

export function setCachedMessageRead(messageId: string, read: boolean): void {
	bumpStateRevision(messageId);
	const cached = getCachedMessageDetail(messageId);
	if (cached?.message) cacheDetail(messageId, { ...cached, message: { ...cached.message, read } });
}

export type CachedMessageStatePatch = Partial<Pick<Message, "read" | "starred" | "status" | "folderId" | "snoozedUntil">>;

/** Field-scoped detail patch for action/undo state; read and star also feed the field store. */
export function patchCachedMessageState(messageId: string, patch: CachedMessageStatePatch): void {
	bumpStateRevision(messageId);
	const cached = getCachedMessageDetail(messageId);
	if (cached?.message) cacheDetail(messageId, { ...cached, message: { ...cached.message, ...patch } });
	rememberMessageFields([messageId], {
		...(patch.read !== undefined ? { read: patch.read } : {}),
		...(patch.starred !== undefined ? { starred: patch.starred } : {}),
	});
}

export function patchCachedMessage(messageId: string, patch: { read?: boolean; starred?: boolean }): void {
	patchCachedMessageState(messageId, patch);
}

function bumpDetailRevision(messageId: string): void {
	detailRevisions.set(messageId, (detailRevisions.get(messageId) ?? 0) + 1);
}

/** Drops in-flight detail responses without throwing away an already-patched cache. */
export function invalidateMessageDetailRequests(messageIds?: string[]): void {
	if (!messageIds) {
		generation += 1;
		detailRequests.clear();
		return;
	}
	for (const id of messageIds) {
		bumpDetailRevision(id);
		detailRequests.delete(id);
	}
}

/** Drops specific details after a failed or partially skipped undo, so the reader refetches them. */
export function invalidateCachedMessageDetails(messageIds: string[]): void {
	for (const id of messageIds) {
		bumpDetailRevision(id);
		detailCache.delete(id);
		detailRequests.delete(id);
	}
}

/** Merge the row header into the cache; a missing body is fetched separately. */
export function primeMessageDetail(message: Message): void {
	const cached = getCachedMessageDetail(message.id);
	const hasBody = message.textBody !== undefined || message.htmlBody !== undefined;
	cacheDetail(message.id, {
		...(cached ?? {}),
		message: { ...cached?.message, ...message },
		...(cached?.body || !hasBody ? {} : {
			body: { textBody: message.textBody ?? null, htmlBody: message.htmlBody ?? null },
		}),
	});
}

export async function fetchCachedMessageDetail(messageId: string, force = false): Promise<CachedMessageDetail> {
	const cached = getCachedMessageDetail(messageId);
	if (!force && cached) return cached;
	if (detailRequests.has(messageId)) return detailRequests.get(messageId) ?? {};
	const requestGeneration = generation;
	const requestRevision = detailRevisions.get(messageId) ?? 0;
	const requestStateRevision = stateRevisions.get(messageId) ?? 0;
	const request = authFetch(`/api/messages/${messageId}`, { cache: "no-store" })
		.then(async (response) => {
			const data = await response.json() as CachedMessageDetail;
			if (requestGeneration !== generation) throw new Error("Message request invalidated");
			if (requestRevision !== (detailRevisions.get(messageId) ?? 0)) throw new Error("Message request invalidated");
			const reconciled = requestStateRevision === (stateRevisions.get(messageId) ?? 0)
				? data
				: preserveNewerState(messageId, data);
			if (response.ok && !reconciled.error) cacheDetail(messageId, reconciled);
			return applyPendingDetail(reconciled);
		})
		.finally(() => { if (detailRequests.get(messageId) === request) detailRequests.delete(messageId); });
	detailRequests.set(messageId, request);
	return request;
}

if (typeof window !== "undefined") {
	window.addEventListener(AUTH_SESSION_CHANGED_EVENT, clearMessageDetailCache);
}
