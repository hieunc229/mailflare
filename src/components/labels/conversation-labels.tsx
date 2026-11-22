"use client";

import { LabelChips } from "./label-chips";
import { useConversationLabels } from "./use-conversation-labels";

/** The labels of the open conversation, shown by its subject. */
export function ConversationLabels({ messageId, className }: { messageId: string; className?: string }) {
	const { labels } = useConversationLabels(messageId);
	return <LabelChips labels={labels} className={className} />;
}
