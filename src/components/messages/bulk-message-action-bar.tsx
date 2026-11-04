"use client";

import { useState } from "react";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import { useLanguage } from "@/components/language-provider";
import { BulkMessageToolbar } from "./bulk-message-toolbar";
import type { BulkMessageActionBarProps } from "./types";
import { PartialDeleteError } from "@/lib/messages/permanent-delete-utils";
import { runBulkMessageAction } from "./utils";

/**
 * Bulk actions for a selection whose messages are listed in the split-view
 * sidebar. It sits above the focused message instead of replacing it.
 */
export function BulkMessageActionBar({
	folder,
	selectedMessages,
	onClearSelection,
}: BulkMessageActionBarProps) {
	const { t } = useLanguage();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const hasUnreadSelection = selectedMessages.some((message) => !message.read);

	async function runAction(action: BulkMessageAction, folderId?: string) {
		if (selectedMessages.length === 0) return;

		setPending(true);
		setError(null);
		try {
			await runBulkMessageAction(
				selectedMessages.map((message) => message.id),
				action,
				true,
				folderId,
			);
			onClearSelection();
		} catch (actionError) {
			setError(actionError instanceof PartialDeleteError ? t("actions.error.deleteSkipped") : t("actions.error.update"));
		} finally {
			setPending(false);
		}
	}

	return (
		<div
			role="region"
			aria-label={t("common.selectedCount", { count: selectedMessages.length })}
			className="shrink-0 border-b border-blue-100 bg-blue-50/50 px-3 py-2"
		>
			<div className="min-w-0 overflow-x-auto">
				<BulkMessageToolbar
					selectedCount={selectedMessages.length}
					hasUnreadSelection={hasUnreadSelection}
					onAction={runAction}
					onClearSelection={onClearSelection}
					pending={pending}
					folder={folder}
				/>
			</div>
			{error && <p role="alert" className="mt-1 text-sm font-medium text-red-700">{error}</p>}
		</div>
	);
}
