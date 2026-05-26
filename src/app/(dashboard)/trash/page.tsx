'use client'

import { Trash2 } from "lucide-react";
import { MessageFolderPage } from "@/components/messages/message-folder-page";

export default function TrashPage() {
	return (
		<MessageFolderPage
			config={{
				folder: "trash",
				title: "Trash",
				emptyText: "No emails in trash",
				hrefPrefix: "/trash",
				icon: Trash2,
				badgeVariant: "outline",
			}}
		/>
	);
}
