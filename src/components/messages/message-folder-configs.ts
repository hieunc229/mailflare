import { Archive, Clock, MailOpen, Send, ShieldAlert, Star, Trash2 } from "lucide-react";
import { ScheduledSendIcon } from "@/components/icons/scheduled-send-icon";
import type { MessageFolderConfig } from "./types";

export const inboxFolderConfig: MessageFolderConfig = {
	folder: "inbox",
	title: "Inbox",
	titleKey: "navigation.inbox",
	emptyTextKey: "folder.empty.inbox",
	emptyText: "No emails",
	hrefPrefix: "/inbox",
	icon: Star,
	// headerIcons: [MailOpen, Clock],
	showRowBadge: false,
};

export const starredFolderConfig: MessageFolderConfig = {
	folder: "starred",
	title: "Starred",
	titleKey: "navigation.starred",
	emptyTextKey: "folder.empty.starred",
	emptyText: "No starred emails",
	hrefPrefix: "/starred",
	icon: Star,
	badgeVariant: "outline",
};

export const snoozedFolderConfig: MessageFolderConfig = {
	folder: "snoozed",
	title: "Snoozed",
	titleKey: "navigation.snoozed",
	emptyTextKey: "folder.empty.snoozed",
	emptyText: "No snoozed emails",
	hrefPrefix: "/snoozed",
	icon: Clock,
	badgeVariant: "outline",
};

export const sentFolderConfig: MessageFolderConfig = {
	folder: "sent",
	title: "Sent",
	titleKey: "navigation.sent",
	emptyTextKey: "folder.empty.inbox",
	emptyText: "No emails",
	hrefPrefix: "/sent",
	icon: Send,
	// headerIcons: [MailOpen, Clock],
	badgeVariant: "outline",
};

export const scheduledFolderConfig: MessageFolderConfig = {
	folder: "scheduled",
	title: "Scheduled",
	titleKey: "navigation.scheduled",
	emptyTextKey: "folder.empty.scheduled",
	emptyText: "No scheduled emails",
	hrefPrefix: "/scheduled",
	icon: ScheduledSendIcon,
	badgeVariant: "outline",
};

export const archivedFolderConfig: MessageFolderConfig = {
	folder: "archived",
	title: "Archived",
	titleKey: "navigation.archived",
	emptyTextKey: "folder.empty.archived",
	emptyText: "No archived emails",
	hrefPrefix: "/archived",
	icon: Archive,
	badgeVariant: "outline",
};

export const spamFolderConfig: MessageFolderConfig = {
	folder: "spam",
	title: "Spam",
	titleKey: "navigation.spam",
	emptyTextKey: "folder.empty.spam",
	emptyText: "No spam",
	hrefPrefix: "/spam",
	icon: ShieldAlert,
	badgeVariant: "outline",
};

export const trashFolderConfig: MessageFolderConfig = {
	folder: "trash",
	title: "Trash",
	titleKey: "navigation.trash",
	emptyTextKey: "folder.empty.trash",
	emptyText: "No emails in trash",
	hrefPrefix: "/trash",
	icon: Trash2,
	badgeVariant: "outline",
};
