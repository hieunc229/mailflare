"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { MailSearchContextValue } from "./types";

const MailSearchContext = createContext<MailSearchContextValue | null>(null);

const DEFAULT_SEARCH_VALUE: MailSearchContextValue = {
	query: "",
	input: "",
	setQuery: () => undefined,
};

export function useMailSearch() {
	const ctx = useContext(MailSearchContext);
	return ctx ?? DEFAULT_SEARCH_VALUE;
}

export function MailSearchProvider({ children }: { children: ReactNode }) {
	const [query, setQuery] = useState("");
	const value = useMemo(() => ({ query, setQuery }), [query]);

	return (
		<MailSearchContext.Provider value={value}>
			{children}
		</MailSearchContext.Provider>
	);
}
