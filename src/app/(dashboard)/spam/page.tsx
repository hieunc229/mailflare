'use client'

import { ShieldAlert } from "lucide-react";
import { MessageFolderPage } from "@/components/messages/message-folder-page";

export default function SpamPage() {
	return (
		<MessageFolderPage
			config={{
				folder: "spam",
				title: "Spam",
				emptyText: "No spam",
				hrefPrefix: "/spam",
				icon: ShieldAlert,
				badgeVariant: "outline",
			}}
		/>
	);
}
