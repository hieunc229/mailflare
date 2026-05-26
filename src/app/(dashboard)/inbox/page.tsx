"use client";

import { Clock, MailOpen, Star } from "lucide-react";
import { MessageFolderPage } from "@/components/messages/message-folder-page";

export default function InboxPage() {
	return (
		<MessageFolderPage
			config={{
				folder: "inbox",
				title: "Inbox",
				emptyText: "No emails",
				hrefPrefix: "/inbox",
				icon: Star,
				headerIcons: [MailOpen, Clock],
				showRowBadge: false,
			}}
		/>
	);
}
