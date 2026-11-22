"use client";

import { useState } from "react";
import { Plus, Tag } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { NavItem } from "@/components/components-nav";
import { NavSectionHeader, useSectionOpen } from "@/components/nav-section-header";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { setConversationLabel, useMailboxLabels } from "@/lib/labels/client";
import { LabelForm } from "./label-form";

/**
 * The selected mailbox's labels under the folders. Choosing one filters the
 * list, the way Starred does; dropping mail on one labels its conversations.
 */
export function NavLabels({ minimal }: { minimal: boolean }) {
	const { t } = useLanguage();
	const { selectedMailbox } = useSelectedMailbox();
	const labels = useMailboxLabels(selectedMailbox?.id);
	const [open, toggle] = useSectionOpen("mailflare:nav:labels-section-open");
	const [dialogOpen, setDialogOpen] = useState(false);
	if (!selectedMailbox) return null;

	return (
		<>
			{!minimal && (
				<NavSectionHeader label={t("navigation.labels")} open={open} onToggle={toggle}>
					<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
						<DialogTrigger asChild>
							<button
								type="button"
								className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 hover:bg-blue-50 hover:text-blue-700"
								aria-label={t("navigation.createLabel")}
							>
								<Plus className="h-4 w-4" />
							</button>
						</DialogTrigger>
						<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
							<DialogHeader>
								<DialogTitle>{t("navigation.createLabel")}</DialogTitle>
								<DialogDescription>{t("label.description")}</DialogDescription>
							</DialogHeader>
							<LabelForm mailboxId={selectedMailbox.id} onCreated={() => setDialogOpen(false)} autoFocus />
						</DialogContent>
					</Dialog>
				</NavSectionHeader>
			)}
			{!minimal && open && labels.length === 0 && (
				<div className="px-4 py-1.5 text-xs text-neutral-500">{t("navigation.noLabels")}</div>
			)}
			{(minimal || open) && labels.map((label) => (
				<NavItem
					key={label.id}
					wrap
					link={{
						href: `/labels/${label.id}`,
						label: label.name,
						icon: Tag,
						iconColor: label.color,
						preloadMessages: true,
						onMessageDrop: (messageIds: string[]) => {
							void Promise.all(messageIds.map((messageId) => setConversationLabel(messageId, label.id, true))).catch(() => {});
						},
					}}
				/>
			))}
		</>
	);
}
