import type { MouseEvent } from "react";

export type MessageNavigationState = {
	onNavigate(event: MouseEvent<HTMLAnchorElement>, markRead?: boolean): void;
	/** Warm the reader while the pointer rests on a row. */
	prefetch(): void;
	/** Warm immediately for touch and keyboard activation. */
	prefetchNow(): void;
	cancelPrefetch(): void;
};
