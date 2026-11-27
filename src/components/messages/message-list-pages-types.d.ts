import type { ReactNode } from "react";
import type { Message, MessageFilterOptions, MessageFolder } from "@/hooks/types";

export type MessageListPageData = {
	messages: Message[];
	updateMessages: (updater: (current: Message[]) => Message[]) => void;
};

export type MessageListQuery = {
	folder: MessageFolder;
	mailboxId?: string | null;
	folderId?: string | null;
	filters: MessageFilterOptions;
	enabled: boolean;
};

export type MessageListPagesProps = {
	query: MessageListQuery;
	pageSize: number;
	total: number;
	/** The first page, which the list keeps loaded for its total and empty state. */
	firstPage: Message[];
	pages: Record<number, MessageListPageData>;
	onPageData: (index: number, data: MessageListPageData | null) => void;
	selectedIds: Set<string>;
	scrollElement: HTMLDivElement | null;
	renderRow: (message: Message) => ReactNode;
};

export type MessageListPageProps = Pick<MessageListPagesProps, "query" | "pageSize" | "onPageData" | "renderRow"> & {
	index: number;
	height: number;
	onHeight: (index: number, height: number) => void;
};
