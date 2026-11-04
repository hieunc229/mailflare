import type { ReactNode } from "react";

export type LoadingTransitionProps = {
	children?: ReactNode;
	ready: boolean;
};

export type PageLoadingContextValue = {
	reportLoading(id: string, loading: boolean, silent?: boolean): void;
};
