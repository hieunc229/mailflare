import { clearMessageCountsCache, clearMessageListCache } from "./utils";

type MessageRefreshTask = () => Promise<unknown>;

const messageRefreshTasks = new Set<MessageRefreshTask>();

export function registerMessageRefresh(task: MessageRefreshTask): () => void {
	messageRefreshTasks.add(task);
	return () => {
		messageRefreshTasks.delete(task);
	};
}

/** Revalidate every mounted list and counts view after invalidating their caches. */
export async function refreshMessageViews(): Promise<void> {
	clearMessageListCache();
	clearMessageCountsCache();
	const results = await Promise.allSettled(Array.from(messageRefreshTasks).map((task) => task()));
	const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (failure) throw failure.reason;
}
