import type { TranslationKey } from "@/lib/i18n/types";
import type { LucideIcon } from "@/components/icons";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { Message, MessageFolder } from "@/hooks/types";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";

export type MessageFolderConfig = {
	folder: MessageFolder;
	title: string;
	/** Translation keys for built-in folders; custom folders show `title` as typed by the user. */
	titleKey?: TranslationKey;
	emptyText: string;
	emptyTextKey?: TranslationKey;
	hrefPrefix: string;
	folderId?: string;
	icon: LucideIcon;
	headerIcons?: LucideIcon[];
	badgeVariant?: "default" | "secondary" | "outline";
	showRowBadge?: boolean;
};

export type MessageListRowProps = {
	message: Message;
	config: MessageFolderConfig;
	selected: boolean;
	active?: boolean;
	compact?: boolean;
	currentAccountName?: string;
	onSelectedChange: (messageId: string, selected: boolean) => void;
	onMessageAction: (messageId: string, action: RowMessageAction) => Promise<void>;
	dragMessageIds: string[];
};

export type RowMessageAction = "archive" | "trash" | "read" | "unread";

export type MessageListRowActionsProps = {
	message: Message;
	onAction: (action: RowMessageAction) => Promise<void>;
};

export type MessageFolderPageProps = {
	config: MessageFolderConfig;
	compact?: boolean;
	selectedMessageId?: string;
};

export type MessageSplitLayoutProps = {
	children: ReactNode;
	config: MessageFolderConfig;
};

export type MessageListVisibility = {
	visible: boolean;
	toggle: () => void;
	singleColumn: boolean;
	backHref: string;
	backLabel: string;
};

export type BulkMessageToolbarProps = {
	selectedCount: number;
	hasUnreadSelection: boolean;
	hideSelectedCount?: boolean;
	onAction: (action: BulkMessageAction, folderId?: string) => void;
	onClearSelection: () => void;
	pending: boolean;
	/** Folder being listed; archived, spam and trash offer a way back instead of the same move. */
	folder?: MessageFolder;
};

export type SelectedMessage = Pick<Message, "id" | "read">;

export type MessageListStateControl = {
	selectedMessages: SelectedMessage[];
	setSelectedMessages: Dispatch<SetStateAction<SelectedMessage[]>>;
	offset: number;
	setOffset: Dispatch<SetStateAction<number>>;
	unreadOnly: boolean;
	setUnreadOnly: Dispatch<SetStateAction<boolean>>;
};

export type BulkMessageActionBarProps = {
	folder?: MessageFolder;
	selectedMessages: SelectedMessage[];
	onClearSelection: () => void;
};

export type PageRange = {
	start: number;
	end: number;
	total: number;
};

export type EmailPageTitleInput = {
	location: string;
	total: number;
	unread: number;
	emailAddress: string | null;
	/** Set for the Inbox, which shows only the unread count. */
	inbox?: boolean;
};
