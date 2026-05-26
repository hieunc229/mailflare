"use client";

import { Clock, MailOpen, Send } from "lucide-react";
import { MessageFolderPage } from "@/components/messages/message-folder-page";

export default function SentPage() {
	return (
		<MessageFolderPage
			config={{
				folder: "sent",
				title: "Sent",
				emptyText: "No emails",
				hrefPrefix: "/sent",
				icon: Send,
				headerIcons: [MailOpen, Clock],
				badgeVariant: "outline",
			}}
		/>
	);
}
