"use client";

import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

type ComposeContextValue = {
	open: boolean;
	openComposer: () => void;
	closeComposer: () => void;
};

const ComposeContext = createContext<ComposeContextValue | null>(null);

export function useCompose() {
	const ctx = useContext(ComposeContext);
	if (!ctx) throw new Error("useCompose must be used within ComposeProvider");
	return ctx;
}

export function ComposeProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);

	return (
		<ComposeContext.Provider
			value={{
				open,
				openComposer: () => setOpen(true),
				closeComposer: () => setOpen(false),
			}}
		>
			{children}
		</ComposeContext.Provider>
	);
}
