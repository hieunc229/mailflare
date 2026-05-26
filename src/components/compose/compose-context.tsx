"use client";

import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

type ComposeContextValue = {
	open: boolean;
	draftId: string | null;
	openComposer: () => void;
	openDraftComposer: (draftId: string) => void;
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
	const [draftId, setDraftId] = useState<string | null>(null);

	return (
		<ComposeContext.Provider
			value={{
				open,
				draftId,
				openComposer: () => {
					setDraftId(null);
					setOpen(true);
				},
				openDraftComposer: (nextDraftId) => {
					setDraftId(nextDraftId);
					setOpen(true);
				},
				closeComposer: () => {
					setOpen(false);
					setDraftId(null);
				},
			}}
		>
			{children}
		</ComposeContext.Provider>
	);
}
