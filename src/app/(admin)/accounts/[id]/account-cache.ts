import type { QueryClient } from "@tanstack/react-query";
import type { ManagedAccount } from "./types";
import { fetchManagedAccount } from "./utils";

export const managedAccountKey = (id: string) => ["account", id] as const;

/** The account tabs share one fetch (the provider's staleTime applies) instead of each tab reloading it. */
export function loadManagedAccount(client: QueryClient, id: string): Promise<ManagedAccount> {
	return client.fetchQuery({ queryKey: managedAccountKey(id), queryFn: () => fetchManagedAccount(id) });
}

/** Call after any successful change so the next tab loads the saved account. */
export function forgetManagedAccount(client: QueryClient, id: string): void {
	void client.invalidateQueries({ queryKey: managedAccountKey(id) });
}
