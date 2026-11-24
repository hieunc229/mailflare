"use client";

import { promotionsFolderConfig } from "@/components/messages/message-folder-configs";
import { MessageSplitLayout } from "@/components/messages/message-split-layout";

export default function PromotionsLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<MessageSplitLayout config={promotionsFolderConfig}>
			{children}
		</MessageSplitLayout>
	);
}
