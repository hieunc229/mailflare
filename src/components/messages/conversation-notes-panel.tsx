"use client";

import { useEffect, useRef, useState } from "react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/hooks/use-current-user";
import { ConversationNoteEmail } from "./conversation-note-email";
import { ConversationNoteItem } from "./conversation-note-item";
import { cn } from "@/lib/utils";
import type { ConversationNotesPanelProps } from "./conversation-notes-types";

/**
 * The notes on a conversation, shown beside the open email. Each note is a
 * profile line (avatar, name, time) over its text; the last block is the form
 * for the next note. Notes are not messages: nothing here replies or forwards.
 */
export function ConversationNotesPanel({ messageId, notes, loading, onAdd, threadMessages, mailboxId, currentAccountName, attachmentId, onAttachmentChange, onUpdate, onRemove, onClose, className }: ConversationNotesPanelProps) {
	const { t } = useLanguage();
	const user = useCurrentUser();
	const [draft, setDraft] = useState("");
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const findMessage = (id: string | null) => threadMessages.find((item) => item.id === id) ?? null;

	// Choosing "Add note" on an email lands the cursor in the new note.
	useEffect(() => {
		if (attachmentId) inputRef.current?.focus();
	}, [attachmentId]);

	async function submit() {
		const body = draft.trim();
		if (!body || saving) return;
		setSaving(true);
		setFailed(false);
		try {
			await onAdd(body, attachmentId);
			setDraft("");
			onAttachmentChange(null);
		} catch {
			setFailed(true);
		} finally {
			setSaving(false);
		}
	}

	return (
		<aside
			aria-label={t("note.title")}
			className={cn("flex max-h-[calc(100dvh-8rem)] w-full flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm", className)}
		>
			<header className="flex shrink-0 items-center justify-between border-b border-neutral-100 py-1.5 pl-4 pr-2">
				<h2 className="text-sm font-semibold text-neutral-900">{t("note.title")}</h2>
				<Tooltip label={t("note.close")}>
					<Button type="button" variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label={t("note.close")} onClick={onClose}>
						<X className="h-4 w-4" />
					</Button>
				</Tooltip>
			</header>
			{notes.length > 0 && (
			<div className="min-h-0 flex-1 divide-y divide-neutral-100 overflow-y-auto overscroll-contain">
				{notes.map((note) => (
					<ConversationNoteItem
						key={note.id}
						messageId={messageId}
						attachedMessage={findMessage(note.messageId)}
						mailboxId={mailboxId}
						currentAccountName={currentAccountName}
						note={note}
						canModify={!!user && note.authorId === user.id}
						onUpdate={onUpdate}
						onRemove={onRemove}
					/>
				))}
			</div>
			)}
			<form
				className={cn("shrink-0 space-y-2 px-4 py-3", notes.length > 0 && "border-t border-neutral-200 bg-neutral-50/60")}
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<div className="flex items-center gap-2.5">
					<ContactAvatar
						mailboxId={null}
						address={user?.email ?? ""}
						name={user?.name ?? ""}
						managedAvatarUrl={user?.hasAvatar ? "/api/profile/avatar" : undefined}
						className="h-8 w-8 text-xs"
					/>
					<p className="truncate text-sm font-medium text-neutral-900">{user?.name}</p>
				</div>
				<textarea
					ref={inputRef}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							void submit();
						}
					}}
					disabled={saving}
					rows={3}
					maxLength={10_000}
					placeholder={t("note.placeholder")}
					aria-label={t("note.placeholder")}
					className="w-full resize-y rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 disabled:opacity-60"
				/>
				{attachmentId && (
					<ConversationNoteEmail message={findMessage(attachmentId)} mailboxId={mailboxId} currentAccountName={currentAccountName} onRemove={() => onAttachmentChange(null)} />
				)}
				<div className="flex items-center justify-end gap-2">
					{failed && <span role="alert" className="mr-auto text-xs text-red-600">{t("note.addFailed")}</span>}
					<Button type="submit" size="sm" disabled={saving || !draft.trim()}>
						{saving ? t("note.adding") : t("note.add")}
					</Button>
				</div>
			</form>
		</aside>
	);
}
