import type { MouseEvent } from "react";

export type MessageNavigationState = {
	progress: number | null;
	onNavigate(event: MouseEvent<HTMLAnchorElement>, markRead?: boolean): void;
	/** Warm the reader while the pointer rests on a row. */
	prefetch(): void;
	cancelPrefetch(): void;
};
