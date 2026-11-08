"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, Ref } from "react";
import { ChevronDown, ChevronUp, Mail, PenLine, Trash2, X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
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
 * The notes under the subject. Closed, a conversation with notes shows one
 * line: how many, who wrote the last one and when. Open, the notes take the
 * width of the conversation, above the mail, with a box to add another.
 * A note is not a message: it has no reply, forward or move.
 */
export function ConversationNotes({ className, contentInset }: ConversationNotesProps) {
	const { t } = useLanguage();
	const notes = useConversationNotes();
	const sectionRef = useRef<HTMLElement>(null);
	const barRef = useRef<HTMLDivElement>(null);
	const wasOpen = useRef(false);
	const open = notes?.open ?? false;

	useEffect(() => {
		if (open && !wasOpen.current) {
			// Focus follows the control that opened the panel; other callers just reveal it.
			if (barRef.current?.contains(document.activeElement)) sectionRef.current?.focus();
			else sectionRef.current?.scrollIntoView({ block: "nearest" });
		}
		wasOpen.current = open;
	}, [open]);

	if (!notes || notes.loading) return null;
	const last = notes.notes.at(-1);
	const showBar = !open && !!last;
	const rowClass = "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none";
	const pad = cn("px-4 sm:pr-6", contentInset);
	const composerPad = cn("sm:pr-2", contentInset);
	return (
		<div className="w-full pb-3">
			<div
				ref={barRef}
				inert={!showBar}
				className={rowClass}
				style={{ gridTemplateRows: showBar ? "1fr" : "0fr" }}
			>
				<div className="min-h-0 overflow-hidden">
					{last && (
						<div className={className}>
							<button
								type="button"
								onClick={() => notes.setOpen(true)}
								aria-expanded={open}
								aria-label={t("note.count", { count: notes.notes.length })}
								className="flex w-full items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-left text-xs text-neutral-600 transition-colors hover:bg-neutral-50 active:bg-neutral-100"
							>
								<PenLine className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
								<span className="shrink-0 font-medium text-neutral-900">{t("note.count", { count: notes.notes.length })}</span>
								<span className="min-w-0 truncate">{last.authorName ?? t("note.formerMember")}</span>
								<time dateTime={last.createdAt} className="ml-auto shrink-0">{formatUserDate(last.createdAt, NOTE_DATE_FORMAT)}</time>
								<ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
							</button>
						</div>
					)}
				</div>
			</div>
			<div
				inert={!open}
				className={rowClass}
				style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
			>
				<div className="min-h-0 overflow-hidden">
					<div
						className={cn(
							"transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-opacity",
							open ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0 motion-reduce:translate-y-0",
						)}
					>
						<OpenNotes ref={sectionRef} pad={pad} composerPad={composerPad} />
					</div>
				</div>
			</div>
		</div>
	);
}

function OpenNotes({ ref, pad, composerPad }: { ref: Ref<HTMLElement>; pad: string; composerPad: string }) {
	const { t } = useLanguage();
	const notes = useConversationNotes()!;

	return (
		<section ref={ref} tabIndex={-1} aria-label={t("note.title")} className="border-y border-neutral-100 bg-neutral-50 outline-none">
			<header className={cn("flex items-center gap-2 border-b border-neutral-100 py-2", pad)}>
				<h2 className="text-sm font-medium text-neutral-900">{t("note.title")}</h2>
				{notes.notes.length > 0 && <span className="text-xs text-neutral-500">{notes.notes.length}</span>}
				<span className="min-w-0 flex-1" />
				<button
					type="button"
					onClick={() => notes.setOpen(false)}
					aria-expanded
					aria-label={t("note.collapse")}
					className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-100 active:bg-neutral-200"
				>
					<ChevronUp className="h-4 w-4" aria-hidden="true" />
				</button>
			</header>
			{notes.notes.length > 0 && (
				<ul className="divide-y divide-neutral-100">
					{notes.notes.map((note) => <NoteItem key={note.id} note={note} pad={pad} />)}
				</ul>
			)}
			<NoteComposer pad={composerPad} />
		</section>
	);
}

function NoteItem({ note, pad }: { note: ConversationNote; pad: string }) {
	const { t } = useLanguage();
	const notes = useConversationNotes()!;
	const editing = note.id in notes.editDrafts;
	const draft = notes.editDrafts[note.id] ?? note.html;
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const author = note.authorName ?? t("note.formerMember");

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
		<li className={cn("flex gap-3 py-3", pad)}>
			<span
				aria-hidden="true"
				className="flex h-[21px] w-[21px] shrink-0 items-center justify-center rounded-full text-[10px] font-medium"
				style={getAvatarColorStyle(author)}
			>
				{author.trim().charAt(0).toUpperCase()}
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-x-2">
					<span className="text-sm font-medium text-neutral-900">{author}</span>
					<span className="ml-auto flex items-center gap-x-2">
						<time dateTime={note.createdAt} className="text-xs text-neutral-500">{formatUserDate(note.createdAt, NOTE_DATE_FORMAT)}</time>
						{note.updatedAt !== note.createdAt && <span className="text-xs text-neutral-400">{t("note.edited")}</span>}
						{!editing && (note.canEdit || note.canDelete) && (
							<span className="flex gap-0.5">
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
					</span>
				</div>
				{note.messageId && <NoteEmailChip messageId={note.messageId} />}
				{editing ? (
					<div className="mt-2">
						<RichTextEditor id={`conversation-note-${note.id}`} value={draft} onChange={(html) => notes.setEditDraft(note.id, html)} disabled={pending} />
						<div className="mt-2 flex items-center justify-end gap-2">
							<Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => notes.setEditDraft(note.id, null)}>
								{t("common.cancel")}
							</Button>
							<Button type="button" size="sm" disabled={pending || !htmlToPlainText(draft).trim()} onClick={() => void save()}>
								{pending ? t("common.saving") : t("note.save")}
							</Button>
						</div>
					</div>
				) : (
					<EmailHtmlRenderer html={note.html} dense className="mt-1.5 text-sm text-neutral-800" />
				)}
				{error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
			</div>
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
	const chipClass = "inline-flex min-w-0 items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600";
	return (
		<span className="mt-1 flex max-w-full items-center gap-1">
			{email ? (
				<button type="button" onClick={() => scrollToEmail(messageId)} className={cn(chipClass, "transition-colors hover:bg-neutral-200 active:bg-neutral-300")}>
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

function NoteComposer({ pad }: { pad: string }) {
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
			className={cn("border-t border-neutral-100", pad)}
		>
			{notes.attachTo && (
				<div className="mx-4 mb-2 mt-3">
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

function scrollToEmail(messageId: string) {
	// A collapsed thread or card reveals the email on this event before it is scrolled to.
	window.dispatchEvent(new CustomEvent("mailflare:reveal-message", { detail: messageId }));
	document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
