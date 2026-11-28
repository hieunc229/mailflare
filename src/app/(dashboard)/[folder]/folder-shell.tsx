"use client";

import {
	archivedFolderConfig,
	promotionsFolderConfig,
	scheduledFolderConfig,
	sentFolderConfig,
	snoozedFolderConfig,
	spamFolderConfig,
	starredFolderConfig,
	trashFolderConfig,
} from "@/components/messages/message-folder-configs";
import { MessageSplitLayout } from "@/components/messages/message-split-layout";
import type { MessageFolderConfig } from "@/components/messages/types";
import type { FolderSlug } from "./folder-slugs";

const folderConfigs: Record<FolderSlug, MessageFolderConfig> = {
	archived: archivedFolderConfig,
	promotions: promotionsFolderConfig,
	sent: sentFolderConfig,
	spam: spamFolderConfig,
	starred: starredFolderConfig,
	trash: trashFolderConfig,
	snoozed: snoozedFolderConfig,
	scheduled: scheduledFolderConfig,
};

export function FolderShell({ folder, children }: { folder: FolderSlug; children: React.ReactNode }) {
	return (
		<MessageSplitLayout key={folder} config={folderConfigs[folder]}>
			{children}
		</MessageSplitLayout>
	);
}
