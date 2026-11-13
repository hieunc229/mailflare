"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ChevronDown, Mail, Note, PenLine, Trash2, X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { ProgressiveAvatarImage } from "@/components/progressive-avatar-image";
import { RichTextEditor } from "@/components/compose/rich-text-editor";
import { htmlToPlainText } from "@/components/compose/rich-text-utils";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { getAvatarColorStyle } from "@/lib/avatar-colors";
import { formatUserDate } from "@/lib/time/utils";
import { cn } from "@/lib/utils";
import type { ConversationNote } from "@/lib/notes/types";
import { EmailHtmlRenderer } from "./email-html-renderer";
import { useConversationNotes } from "./conversation-notes-context";
import type { ConversationNotesProps } from "./conversation-notes-types";

const NOTE_DATE_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

/**
 * The notes under the subject, in one box. Closed, a conversation with notes
 * shows one line: how many, who wrote the last one and when. Opening expands
 * that same box downward to list the notes and a box to add another.
 * A note is not a message: it has no reply, forward or move.
 */
export function ConversationNotes({ className }: ConversationNotesProps) {
	const { t } = useLanguage();
	const notes = useConversationNotes();
	const sectionRef = useRef<HTMLElement>(null);
	const headerRef = useRef<HTMLButtonElement>(null);
	const wasOpen = useRef(false);
	const open = notes?.open ?? false;

	useEffect(() => {
		if (open && !wasOpen.current) {
			// Focus follows the control that opened the panel; other callers just reveal it.
			if (document.activeElement === headerRef.current) sectionRef.current?.focus();
			else sectionRef.current?.scrollIntoView({ block: "nearest" });
		}
		wasOpen.current = open;
	}, [open]);

	if (!notes || notes.loading) return null;
	const last = notes.notes.at(-1);
	const visible = open || !!last;
	const rowClass = "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none";
	return (
		<div className="w-full pb-3">
			<div inert={!visible} className={rowClass} style={{ gridTemplateRows: visible ? "1fr" : "0fr" }}>
				<div className="min-h-0 overflow-hidden">
					<div className={className}>
						<section ref={sectionRef} tabIndex={-1} aria-label={t("note.title")} className="overflow-hidden rounded-lg border border-amber-200 bg-amber-50 outline-none">
							<button
								ref={headerRef}
								type="button"
								onClick={() => notes.setOpen(!open)}
								aria-expanded={open}
								aria-label={open ? t("note.collapse") : t("note.count", { count: notes.notes.length })}
								className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-amber-900/80 transition-colors hover:bg-amber-100/70 active:bg-amber-100"
							>
								<Note className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
								<span className="shrink-0 font-medium text-amber-950">
									{open ? t("note.title") : t("note.count", { count: notes.notes.length })}
								</span>
								{open && notes.notes.length > 0 && <span className="shrink-0">{notes.notes.length}</span>}
								{!open && last && (
									<>
										<span className="min-w-0 truncate">{last.authorName ?? t("note.formerMember")}</span>
										<time dateTime={last.createdAt} className="ml-auto shrink-0">{formatUserDate(last.createdAt, NOTE_DATE_FORMAT)}</time>
									</>
								)}
								<ChevronDown
									className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none", open ? "rotate-180" : "", open && "ml-auto")}
									aria-hidden="true"
								/>
							</button>
							<div inert={!open} className={rowClass} style={{ gridTemplateRows: open ? "1fr" : "0fr" }}>
								<div className="min-h-0 overflow-hidden">
									<NotesBody />
								</div>
							</div>
						</section>
					</div>
				</div>
			</div>
		</div>
	);
}

/** The notes of the conversation and the box to add one, without the box around them. `bare` drops the top rule for a container that has no header above it. */
export function NotesBody({ bare = false }: { bare?: boolean }) {
	const notes = useConversationNotes();
	if (!notes) return null;
	return (
		<div>
			{notes.notes.length > 0 && (
				<ul className={cn("divide-y divide-amber-200/70", !bare && "border-t border-amber-200/70")}>
					{notes.notes.map((note) => <NoteItem key={note.id} note={note} />)}
				</ul>
			)}
			<NoteComposer />
		</div>
	);
}

function NoteItem({ note }: { note: ConversationNote }) {
	const { t } = useLanguage();
	const notes = useConversationNotes()!;
	const editing = note.id in notes.editDrafts;
	const draft = notes.editDrafts[note.id] ?? note.html;
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const author = note.authorName ?? t("note.formerMember");
	const editRef = useRef<HTMLDivElement>(null);
	const canSave = !pending && !!htmlToPlainText(draft).trim();

	// Put the cursor in the editor when edit mode opens, as the new-note box does.
	useEffect(() => {
		if (!editing) return;
		const timer = window.setTimeout(() => {
			const field = editRef.current?.querySelector<HTMLElement>("[contenteditable='true']");
			if (!field) return;
			field.focus();
			const range = document.createRange();
			range.selectNodeContents(field);
			range.collapse(false);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
		}, 0);
		return () => window.clearTimeout(timer);
	}, [editing]);

	async function save() {
		setPending(true);
		setError(null);
		try {
			await notes.update(note.id, draft);
		} catch {
			setError(t("note.saveFailed"));
		} finally {
			setPending(false);
		}
	}

	async function remove() {
		if (!window.confirm(t("note.deleteConfirm"))) return;
		setPending(true);
		setError(null);
		try {
			await notes.remove(note.id);
		} catch {
			setError(t("note.deleteFailed"));
			setPending(false);
		}
	}

	return (
		<li className="group relative flex gap-3 px-3 py-2">
			<NoteAvatar note={note} author={author} />
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-x-2">
					<span className="text-sm font-medium text-amber-950">{author}</span>
					<span className="ml-auto flex items-center gap-x-2">
						<time dateTime={note.createdAt} className="text-xs text-amber-900/70">{formatUserDate(note.createdAt, NOTE_DATE_FORMAT)}</time>
						{note.updatedAt !== note.createdAt && <span className="text-xs text-amber-900/50">{t("note.edited")}</span>}
					</span>
				</div>
				{note.messageId && <NoteEmailChip messageId={note.messageId} />}
				{editing ? (
					<div
						ref={editRef}
						onKeyDown={(event) => {
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSave) {
								event.preventDefault();
								void save();
							} else if (event.key === "Escape" && !pending) {
								event.preventDefault();
								notes.setEditDraft(note.id, null);
							}
						}}
						className="mt-1"
					>
						<RichTextEditor
							id={`conversation-note-${note.id}`}
							value={draft}
							onChange={(html) => notes.setEditDraft(note.id, html)}
							disabled={pending}
							placeholder={t("note.placeholder")}
							editableClassName="min-h-9 py-2"
							toolbarClassName="border-t-0"
							toolbarEnd={
								<span className="ml-auto flex items-center gap-2">
									<Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => notes.setEditDraft(note.id, null)} className="h-7">
										{t("common.cancel")}
									</Button>
									<Button type="button" size="sm" disabled={!canSave} onClick={() => void save()} className="h-7">
										{pending ? t("common.saving") : t("note.save")}
									</Button>
								</span>
							}
						/>
					</div>
				) : (
					<EmailHtmlRenderer html={note.html} dense className="mt-0.5 text-sm text-neutral-900" />
				)}
				{error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
			</div>
			{!editing && (note.canEdit || note.canDelete) && (
				<span className="absolute bottom-2 right-3 flex gap-0.5 rounded-md bg-amber-50/90 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100">
					{note.canEdit && (
						<Tooltip label={t("note.edit")}>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={pending}
								aria-label={t("note.edit")}
								onClick={() => { notes.setEditDraft(note.id, note.html); setError(null); }}
								className="h-6 w-6 px-0"
							>
								<PenLine className="h-3.5 w-3.5" />
							</Button>
						</Tooltip>
					)}
					{note.canDelete && (
						<Tooltip label={t("note.delete")}>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={pending}
								aria-label={t("note.delete")}
								onClick={() => void remove()}
								className="h-6 w-6 px-0 hover:bg-red-50 hover:text-red-600 active:bg-red-100"
							>
								<Trash2 className="h-3.5 w-3.5" />
							</Button>
						</Tooltip>
					)}
				</span>
			)}
		</li>
	);
}

/** Names the email a note is about; clicking it scrolls the conversation to that email. */
function NoteEmailChip({ messageId, onRemove }: { messageId: string; onRemove?: () => void }) {
	const { t } = useLanguage();
	const notes = useConversationNotes()!;
	const email = notes.email(messageId);
	const label = email
		? email.recipient
			? t("note.aboutEmailTo", { name: email.recipient, date: formatUserDate(email.createdAt, NOTE_DATE_FORMAT) })
			: t("note.aboutEmail", { name: email.sender, date: formatUserDate(email.createdAt, NOTE_DATE_FORMAT) })
		: t("note.aboutAnEmail");
	const chipClass = "inline-flex min-w-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900";
	return (
		<span className="mt-1 flex max-w-full items-center gap-1">
			{email ? (
				<button type="button" onClick={() => scrollToEmail(messageId)} className={cn(chipClass, "transition-colors hover:bg-amber-200/70 active:bg-amber-200")}>
					<Mail className="h-3 w-3 shrink-0" aria-hidden="true" />
					<span className="truncate">{label}</span>
				</button>
			) : (
				<span className={chipClass}>
					<Mail className="h-3 w-3 shrink-0" aria-hidden="true" />
					<span className="truncate">{label}</span>
				</span>
			)}
			{onRemove && (
				<button type="button" onClick={onRemove} aria-label={t("note.detach")} className="rounded-full p-0.5 text-neutral-500 transition-colors hover:bg-neutral-100 active:bg-neutral-200">
					<X className="h-3 w-3" aria-hidden="true" />
				</button>
			)}
		</span>
	);
}

function NoteComposer() {
	const { t } = useLanguage();
	const notes = useConversationNotes()!;
	const { focusRequest, focusHandled } = notes;
	const [failed, setFailed] = useState(false);
	const [focused, setFocused] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const empty = !htmlToPlainText(notes.draft).trim();
	const active = focused || !empty;

	useEffect(() => {
		if (focusRequest === 0) return;
		// A menu that opened the box gives focus back to its trigger in a timeout when it closes; focus after it.
		const timer = window.setTimeout(() => {
			containerRef.current?.querySelector<HTMLElement>("[contenteditable='true']")?.focus();
			focusHandled();
		}, 0);
		return () => window.clearTimeout(timer);
	}, [focusRequest, focusHandled]);

	async function submit() {
		if (empty || notes.adding) return;
		setFailed(false);
		try {
			await notes.add(notes.draft);
		} catch {
			setFailed(true);
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void submit();
		}
	}

	return (
		<div
			ref={containerRef}
			onKeyDown={onKeyDown}
			onFocus={() => setFocused(true)}
			onBlur={(event) => { if (!containerRef.current?.contains(event.relatedTarget as Node | null)) setFocused(false); }}
			className="border-t border-amber-200/70 px-3 p-2"
		>
			{notes.attachTo && (
				<div className="mb-2 mt-3">
					<NoteEmailChip messageId={notes.attachTo} onRemove={() => notes.setAttachTo(null)} />
				</div>
			)}
			<RichTextEditor
				id="conversation-note-new"
				value={notes.draft}
				onChange={notes.setDraft}
				disabled={notes.adding}
				placeholder={t("note.placeholder")}
				editableClassName="min-h-9 py-2"
				toolbarVisible={active}
				toolbarClassName="border-t-0"
				toolbarEnd={
					<span className="ml-auto flex items-center gap-2">
						{failed && <span role="alert" className="text-xs text-red-600">{t("note.saveFailed")}</span>}
						{(!empty || notes.adding) && (
							<Button type="button" size="sm" disabled={notes.adding || empty} onClick={() => void submit()} className="h-7">
								{notes.adding ? t("common.saving") : t("note.add")}
							</Button>
						)}
					</span>
				}
			/>
		</div>
	);
}

/** The author's own profile picture, or their initial when they have none. */
function NoteAvatar({ note, author }: { note: ConversationNote; author: string }) {
	const { t } = useLanguage();
	const messageId = useConversationNotes()!.messageId;
	const [failed, setFailed] = useState(false);
	const base = "h-6 w-6 shrink-0 rounded-full";
	if (note.authorId && note.authorHasAvatar && !failed) {
		return (
			<ProgressiveAvatarImage
				src={`/api/messages/${encodeURIComponent(messageId)}/notes/avatar/${encodeURIComponent(note.authorId)}`}
				alt={t("account.profilePicture", { name: author })}
				className={cn(base, "object-cover")}
				skipPreview
				onError={() => setFailed(true)}
			/>
		);
	}
	return (
		<span aria-hidden="true" className={cn(base, "flex items-center justify-center text-[11px] font-medium")} style={getAvatarColorStyle(author)}>
			{author.trim().charAt(0).toUpperCase()}
		</span>
	);
}

function scrollToEmail(messageId: string) {
	// A collapsed thread or card reveals the email on this event before it is scrolled to.
	window.dispatchEvent(new CustomEvent("mailflare:reveal-message", { detail: messageId }));
	document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
