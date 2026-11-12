"use client";

import { FileText } from "@/components/icons";
import { MessageFolderPage } from "@/components/messages/message-folder-page";
import type { MessageFolderConfig } from "@/components/messages/types";

const draftsFolderConfig: MessageFolderConfig = {
	folder: "drafts",
	title: "Drafts",
	titleKey: "navigation.drafts",
	emptyText: "No drafts",
	emptyTextKey: "folder.drafts.empty",
	hrefPrefix: "/drafts",
	icon: FileText,
	badgeVariant: "outline",
};

export default function DraftsPage() {
	return <MessageFolderPage config={draftsFolderConfig} />;
}
