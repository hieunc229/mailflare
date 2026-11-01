"use client";

import { useState } from "react";
import { PenLine, Pencil, Plus } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { RichTextEditor } from "@/components/compose/rich-text-editor";
import { formatUserDate } from "@/lib/time/utils";
import { cn } from "@/lib/utils";
import { EmailHtmlRenderer } from "./email-html-renderer";
import { useConversationNote } from "./use-conversation-note";
import type { ConversationNoteProps } from "./conversation-note-types";

const NOTE_DATE_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" };

/**
 * The private note pinned above a conversation: one note per thread, shared by
 * everyone who can read the mailbox. It is deliberately not a message, so it
 * carries no reply/forward affordances — only add, edit and save.
 */
export function ConversationNote({ messageId, className }: ConversationNoteProps) {
	const { t } = useLanguage();
	const { note, loading, save } = useConversationNote(messageId);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState(false);

	// Navigating to another conversation remounts this (key={messageId} at the call site), dropping a half-written edit.

	function startEditing() {
		setDraft(note?.html ?? "");
		setFailed(false);
		setEditing(true);
	}

	async function submit() {
		setSaving(true);
		setFailed(false);
		try {
			await save(draft);
			setEditing(false);
		} catch {
			setFailed(true);
		} finally {
			setSaving(false);
		}
	}

	if (loading) return null;

	if (editing) {
		return (
			<section
				aria-label={t("note.title")}
				className={cn("mx-4 mb-2 overflow-hidden rounded-xl border border-amber-200/80 bg-amber-50/70 sm:mx-6", className)}
			>
				<header className="flex items-center gap-2 px-4 pt-3 text-amber-900">
					<PenLine className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
					<span className="text-xs font-semibold uppercase tracking-wide">{t("note.title")}</span>
					<span className="min-w-0 flex-1 truncate text-xs text-amber-800/70">{t("note.sharedHint")}</span>
				</header>
				<RichTextEditor
					id={`conversation-note-${messageId}`}
					value={draft}
					onChange={setDraft}
					disabled={saving}
					placeholder={t("note.placeholder")}
				/>
				<div className="flex items-center justify-end gap-2 border-t border-amber-200/60 px-4 py-2">
					{failed && <span role="alert" className="mr-auto text-xs text-red-600">{t("note.saveFailed")}</span>}
					<button
						type="button"
						onClick={() => setEditing(false)}
						disabled={saving}
						className="rounded-md px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60"
					>
						{t("common.cancel")}
					</button>
					<button
						type="button"
						onClick={() => void submit()}
						disabled={saving}
						className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60"
					>
						{saving ? t("common.saving") : t("note.save")}
					</button>
				</div>
			</section>
		);
	}

	if (!note) {
		return (
			<div className={cn("px-4 pb-2 sm:px-6", className)}>
				<button
					type="button"
					onClick={startEditing}
					className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-amber-300 bg-amber-50/50 px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100/70"
				>
					<Plus className="h-3.5 w-3.5" aria-hidden="true" />
					{t("note.add")}
				</button>
			</div>
		);
	}

	return (
		<section
			aria-label={t("note.title")}
			className={cn("mx-4 mb-2 rounded-xl border border-amber-200/80 bg-amber-50/70 px-4 py-3 sm:mx-6", className)}
		>
			<header className="mb-1 flex items-center gap-2">
				<PenLine className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
				<span className="text-xs font-semibold uppercase tracking-wide text-amber-900">{t("note.title")}</span>
				<span className="min-w-0 flex-1 truncate text-xs text-amber-800/70">{t("note.sharedHint")}</span>
				<button
					type="button"
					onClick={startEditing}
					className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
				>
					<Pencil className="h-3.5 w-3.5" aria-hidden="true" />
					{t("note.edit")}
				</button>
			</header>
			<EmailHtmlRenderer html={note.html} />
			<footer className="mt-1 text-xs text-amber-800/80">
				{note.savedByName
					? t("note.savedBy", { name: note.savedByName, date: formatUserDate(note.updatedAt, NOTE_DATE_FORMAT) })
					: t("note.savedAt", { date: formatUserDate(note.updatedAt, NOTE_DATE_FORMAT) })}
			</footer>
		</section>
	);
}
