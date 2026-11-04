"use client";

import { FileText } from "@/components/icons";
import { MessageFolderPage } from "@/components/messages/message-folder-page";

export default function DraftsPage() {
	return (
		<MessageFolderPage
			config={{
				folder: "drafts",
				title: "Drafts",
				titleKey: "navigation.drafts",
				emptyText: "No drafts",
				emptyTextKey: "folder.drafts.empty",
				hrefPrefix: "/drafts",
				icon: FileText,
				badgeVariant: "outline",
			}}
		/>
	);
}
