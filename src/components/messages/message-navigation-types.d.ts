import type { MouseEvent } from "react";

export type MessageNavigationState = {
	onNavigate(event: MouseEvent<HTMLAnchorElement>, markRead?: boolean): void;
	prefetch(): void;
	prefetchNow(): void;
	cancelPrefetch(): void;
};
