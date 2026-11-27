"use client";

import { Folder } from "@/components/icons";
import { useEffect, useMemo, useState } from "react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { getMailboxFolders } from "@/lib/folders/client";
import type { CustomFolderSummary } from "./custom-folder-config-types";
import type { MessageFolderConfig } from "./types";

export function useCustomFolderConfig(folderId: string): MessageFolderConfig {
	const { selectedMailbox } = useSelectedMailbox();
	const [folderName, setFolderName] = useState("Folder");
	const [revision, setRevision] = useState(0);

	useEffect(() => {
		const reload = () => setRevision((value) => value + 1);
		window.addEventListener("mailflare:folders-changed", reload);
		return () => window.removeEventListener("mailflare:folders-changed", reload);
	}, []);

	useEffect(() => {
		if (!selectedMailbox?.id) return;
		let cancelled = false;
		getMailboxFolders<{ folders?: CustomFolderSummary[] }>(selectedMailbox.id)
			.then((data) => {
				if (cancelled) return;
				const folder = data.folders?.find((item) => item.id === folderId);
				if (folder) setFolderName(folder.name);
			})
			.catch(() => {});

		return () => {
			cancelled = true;
		};
	}, [folderId, selectedMailbox?.id, revision]);

	return useMemo(
		() => ({
			folder: "inbox",
			folderId,
			title: folderName,
			emptyText: "No emails in this folder",
			hrefPrefix: `/folders/${folderId}`,
			icon: Folder,
			showRowBadge: false,
		}),
		[folderId, folderName],
	);
}
