"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import { Tag } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { MessageSplitLayout } from "@/components/messages/message-split-layout";
import type { MessageFolderConfig } from "@/components/messages/types";
import { useMailboxLabels } from "@/lib/labels/client";

/**
 * A label is a filter, not a destination: this is the inbox list narrowed to
 * conversations carrying the label. Choosing it moves nothing.
 */
export default function LabelLayout({ children }: { children: React.ReactNode }) {
	const { labelId } = useParams<{ labelId: string }>();
	const { t } = useLanguage();
	const { selectedMailbox } = useSelectedMailbox();
	const label = useMailboxLabels(selectedMailbox?.id).find((item) => item.id === labelId);
	const name = label?.name ?? t("navigation.labels");
	const emptyText = t("label.empty");
	const config = useMemo<MessageFolderConfig>(() => ({
		folder: "inbox",
		labelId,
		title: name,
		emptyText,
		hrefPrefix: `/labels/${labelId}`,
		icon: Tag,
		showRowBadge: false,
	}), [labelId, name, emptyText]);
	return <MessageSplitLayout config={config}>{children}</MessageSplitLayout>;
}
