import { clearMessageCountsCache, clearMessageListCache } from "./utils";

type MessageRefreshTask = () => Promise<unknown>;

const messageRefreshTasks = new Set<MessageRefreshTask>();

/**
 * Registers a mounted list or counts view for explicit refresh. Every mounted
 * view keeps its own task so it can update its own state; tasks that read the
 * same query share one request through the existing fetcher caches.
 */
export function registerMessageRefresh(task: MessageRefreshTask): () => void {
	messageRefreshTasks.add(task);
	return () => {
		messageRefreshTasks.delete(task);
	};
}

/**
 * Revalidates every mounted mail list and counts view from the API. The caches
 * are invalidated once up front, while each hook's request sequence ignores any
 * response that was already in flight before this refresh started.
 */
export async function refreshMessageViews(): Promise<void> {
	clearMessageListCache();
	clearMessageCountsCache();
	const results = await Promise.allSettled(Array.from(messageRefreshTasks).map((task) => task()));
	const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (failure) throw failure.reason;
}
