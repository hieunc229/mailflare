"use client";

import { useState } from "react";
import { RichTextEditor } from "@/components/compose/rich-text-editor";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Edit03, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { noteBodyToHtml, noteHasContent } from "@/lib/notes/html";
import { ConversationNoteEmail } from "./conversation-note-email";
import { EmailHtmlRenderer } from "./email-html-renderer";
import { formatUserDate } from "@/lib/time/utils";
import type { ConversationNoteItemProps } from "./conversation-notes-types";

const NOTE_DATE_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" };

/** One note: author and time, its text, and edit/delete when the reader is the author. */
export function ConversationNoteItem({ messageId, attachedMessage, mailboxId, currentAccountName, note, canModify, onUpdate, onRemove }: ConversationNoteItemProps) {
	const { t } = useLanguage();
	const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
	const [draft, setDraft] = useState(() => noteBodyToHtml(note.body));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const name = note.authorName ?? t("note.deletedAuthor");

	function startEditing() {
		setDraft(noteBodyToHtml(note.body));
		setError(null);
		setMode("edit");
	}

	async function save() {
		const body = draft.trim();
		if (!noteHasContent(body) || busy) return;
		if (body === noteBodyToHtml(note.body)) {
			setMode("view");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await onUpdate(note.id, body);
			setMode("view");
		} catch {
			setError(t("note.saveFailed"));
		} finally {
			setBusy(false);
		}
	}

	async function confirmDelete() {
		setBusy(true);
		setError(null);
		try {
			await onRemove(note.id);
		} catch {
			setError(t("note.deleteFailed"));
			setBusy(false);
		}
	}

	return (
		<article className="group px-4 py-3">
			<div className="flex items-center gap-2.5">
				<ContactAvatar
					mailboxId={null}
					address={note.authorId ?? name}
					name={name}
					managedAvatarUrl={note.authorId && note.authorHasAvatar ? `/api/messages/${messageId}/notes/avatar/${note.authorId}` : undefined}
					className="h-8 w-8 text-xs"
				/>
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-medium text-neutral-900">{name}</p>
					<time dateTime={note.createdAt} className="block text-xs text-neutral-500">{formatUserDate(note.createdAt, NOTE_DATE_FORMAT)}</time>
				</div>
			</div>
			{mode === "edit" ? (
				<div className="mt-2 space-y-2">
					<div className="flex max-h-56 flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white focus-within:border-blue-400">
						<RichTextEditor
							id={`note-edit-${note.id}`}
							value={draft}
							onChange={setDraft}
							disabled={busy}
							toolbarPosition="top"
							formats="basic"
							compact
							ariaLabel={t("note.edit")}
							onSubmitShortcut={() => void save()}
						/>
					</div>
					<div className="flex items-center justify-end gap-2">
						{error && <span role="alert" className="mr-auto text-xs text-red-600">{error}</span>}
						<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setMode("view")}>{t("common.cancel")}</Button>
						<Button type="button" size="sm" disabled={busy || !noteHasContent(draft)} onClick={() => void save()}>{busy ? t("common.saving") : t("note.save")}</Button>
					</div>
				</div>
			) : (
				<div className="relative mt-2">
					<EmailHtmlRenderer html={noteBodyToHtml(note.body)} />
				{canModify && mode === "view" && (
					<div className="absolute bottom-0 right-0 flex items-center rounded-md bg-white/95 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
						<Tooltip label={t("note.edit")}>
							<Button type="button" variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label={t("note.edit")} onClick={startEditing}>
								<Edit03 className="h-3.5 w-3.5" />
							</Button>
						</Tooltip>
						<Tooltip label={t("note.delete")}>
							<Button type="button" variant="ghost" size="sm" className="h-7 w-7 px-0 text-red-600 hover:bg-red-50 hover:text-red-700" aria-label={t("note.delete")} onClick={() => { setError(null); setMode("delete"); }}>
								<Trash2 className="h-3.5 w-3.5" />
							</Button>
						</Tooltip>
					</div>
				)}
				</div>
			)}
			{note.messageId && <ConversationNoteEmail className="mt-2" message={attachedMessage} mailboxId={mailboxId} currentAccountName={currentAccountName} />}
			{mode === "delete" && (
				<div role="alert" className="mt-2 flex items-center justify-end gap-2 text-sm">
					<span className="mr-auto text-neutral-700">{t("note.deleteConfirm")}</span>
					<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setMode("view")}>{t("common.cancel")}</Button>
					<Button type="button" size="sm" disabled={busy} className="bg-red-600 text-white hover:bg-red-700" onClick={() => void confirmDelete()}>{t("common.delete")}</Button>
				</div>
			)}
			{mode !== "edit" && error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
		</article>
	);
}
