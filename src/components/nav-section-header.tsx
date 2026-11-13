"use client";

import { useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { ChevronRight } from "@/components/icons";
import { cn } from "@/lib/utils";
import { readStorage, writeStorage } from "./reorderable-list-utils";

const subscribeNothing = () => () => {};
const hydratedOnClient = () => true;
const hydratedOnServer = () => false;

/** Open/closed state of a menu section, remembered in localStorage. Starts open. */
export function useSectionOpen(storageKey: string): [boolean, () => void] {
	// Storage is read after hydration so the server and first client render agree.
	const hydrated = useSyncExternalStore(subscribeNothing, hydratedOnClient, hydratedOnServer);
	const [toggled, setToggled] = useState<{ key: string; open: boolean } | null>(null);
	const open = toggled?.key === storageKey ? toggled.open : hydrated ? readStorage(storageKey, true) : true;
	function toggle() {
		writeStorage(storageKey, !open);
		setToggled({ key: storageKey, open: !open });
	}
	return [open, toggle];
}

/** Collapsible section label: small uppercase text behind a chevron that turns when the section opens. */
export function NavSectionHeader({ label, open, onToggle, children }: { label: string; open: boolean; onToggle: () => void; children?: ReactNode }) {
	return (
		<div className="mt-2 flex h-9 shrink-0 items-center justify-between gap-1 ml-3 mr-2 hover:bg-neutral-200/60 rounded-full pr-2">
			<button type="button" onClick={onToggle} aria-expanded={open} className="flex h-9 min-w-0 flex-1 items-center gap-2 pl-3 pr-3 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500 max-md:text-sm">
				<ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="truncate">{label}</span>
			</button>
			{children}
		</div>
	);
}
