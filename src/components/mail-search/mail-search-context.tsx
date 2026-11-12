"use client";

import { createContext, useContext, useEffect, useState } from "react";
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

const SEARCH_DEBOUNCE_MS = 250;

export function MailSearchProvider({ children }: { children: ReactNode }) {
	// `input` follows every keystroke; `query` is what lists fetch with, and
	// trails it slightly so a typed word costs one request instead of one per letter.
	const [input, setInput] = useState("");
	const [query, setQuery] = useState("");

	useEffect(() => {
		// Clearing the box should empty the list at once; typing waits for a pause.
		const delay = input.trim() ? SEARCH_DEBOUNCE_MS : 0;
		const timer = setTimeout(() => setQuery(input.trim() ? input : ""), delay);
		return () => clearTimeout(timer);
	}, [input]);

	return (
		<MailSearchContext.Provider value={{ query, input, setQuery: setInput }}>
			{children}
		</MailSearchContext.Provider>
	);
}
