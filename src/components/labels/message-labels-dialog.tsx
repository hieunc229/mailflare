"use client";

import { useState } from "react";
import { Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Checkbox } from "@/components/ui/checkbox";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { deleteLabel, setConversationLabel, useMailboxLabels } from "@/lib/labels/client";
import { LabelChips } from "./label-chips";
import { LabelForm } from "./label-form";
import { useConversationLabels } from "./use-conversation-labels";

/**
 * Ticks the mailbox's labels on or off for the conversation of `messageId`.
 * Nothing moves. A label created here is put on the conversation straight away.
 */
export function MessageLabelsDialog({ messageId, mailboxId, open, onOpenChange }: { messageId: string; mailboxId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
	const { t } = useLanguage();
	const mailboxLabels = useMailboxLabels(open ? mailboxId : null);
	const { labels: applied, setLabels } = useConversationLabels(messageId, open);
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const appliedIds = new Set(applied.map((label) => label.id));

	async function toggle(labelId: string, next: boolean) {
		setPending(labelId);
		setError(null);
		try {
			setLabels(await setConversationLabel(messageId, labelId, next));
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("label.changeFailed"));
		} finally {
			setPending(null);
		}
	}

	async function remove(labelId: string, name: string) {
		if (!await confirmDestructive(t("label.deleteConfirm", { name }))) return;
		setError(null);
		try {
			await deleteLabel(labelId);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("label.changeFailed"));
		}
	}

	return (
		<Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setError(null); }}>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("navigation.labels")}</DialogTitle>
					<DialogDescription>{t("label.description")}</DialogDescription>
				</DialogHeader>
				{mailboxLabels.length > 0 ? (
					<ul className="-mx-2 space-y-0.5">
						{mailboxLabels.map((label) => (
							<li key={label.id} className="group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-neutral-50">
								<Checkbox
									id={`label-${messageId}-${label.id}`}
									checked={appliedIds.has(label.id)}
									disabled={pending !== null}
									onChange={(event) => void toggle(label.id, event.target.checked)}
								/>
								<label htmlFor={`label-${messageId}-${label.id}`} className="min-w-0 flex-1 cursor-pointer">
									<LabelChips labels={[label]} />
								</label>
								<button
									type="button"
									className="rounded p-1 text-neutral-400 opacity-0 hover:bg-neutral-100 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
									aria-label={`${t("label.delete")}: ${label.name}`}
									title={t("label.delete")}
									onClick={() => void remove(label.id, label.name)}
								>
									<Trash2 className="h-4 w-4" />
								</button>
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-neutral-500">{t("navigation.noLabels")}</p>
				)}
				{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
				<div className="border-t border-neutral-200 pt-4">
					<LabelForm mailboxId={mailboxId} onCreated={(label) => void toggle(label.id, true)} />
				</div>
			</DialogContent>
		</Dialog>
	);
}
