"use client";

import { FileText } from "lucide-react";
import { MessageFolderPage } from "@/components/messages/message-folder-page";

export default function DraftsPage() {
	return (
		<MessageFolderPage
			config={{
				folder: "drafts",
				title: "Drafts",
				emptyText: "No drafts",
				hrefPrefix: "/drafts",
				icon: FileText,
				badgeVariant: "outline",
			}}
		/>
	);
}
