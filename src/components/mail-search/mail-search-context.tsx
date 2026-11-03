"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { MailSearchContextValue } from "./types";

const MailSearchContext = createContext<MailSearchContextValue | null>(null);

export function useMailSearch() {
	const ctx = useContext(MailSearchContext);
	if (!ctx) throw new Error("useMailSearch must be used within MailSearchProvider");
	return ctx;
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
