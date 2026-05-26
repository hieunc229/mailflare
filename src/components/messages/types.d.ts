import type { LucideIcon } from "lucide-react";
import type { Message, MessageFolder } from "@/hooks/types";

export type MessageFolderConfig = {
	folder: MessageFolder;
	title: string;
	emptyText: string;
	hrefPrefix: string;
	icon: LucideIcon;
	headerIcons?: LucideIcon[];
	badgeVariant?: "default" | "secondary" | "outline";
	showRowBadge?: boolean;
};

export type MessageListRowProps = {
	message: Message;
	config: MessageFolderConfig;
};
