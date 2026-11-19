"use client";

import { allInboxesFolderConfig } from "@/components/messages/message-folder-configs";
import { MessageSplitLayout } from "@/components/messages/message-split-layout";

export default function AllInboxesLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<MessageSplitLayout config={allInboxesFolderConfig}>
			{children}
		</MessageSplitLayout>
	);
}
