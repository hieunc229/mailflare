"use client";

import { useEffect, useState } from "react";
import { StickyNote } from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { RichTextEditor } from "@/components/compose/rich-text-editor";
import { hasMeaningfulHtml, isHtmlSignature, textToHtml } from "@/components/compose/rich-text-utils";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { formatUserDate } from "@/lib/time/utils";
import { cn } from "@/lib/utils";

type ThreadNoteValue = {
	body: string;
	updatedByName: string | null;
	updatedAt: string;
};

/** Notes saved before formatting are plain text. The editor needs HTML. */
function editorHtml(body: string): string {
	if (!body) return "";
	return isHtmlSignature(body) ? body : textToHtml(body);
}

/**
 * The conversation note. It is loaded on its own route so the message body
 * passed to reply and forward never includes it. A saved note is rendered
 * HTML, so its links can be opened. Edit is what turns the composer on.
 */
export function ThreadNote({ messageId, className }: { messageId: string; className?: string }) {
	const { t } = useLanguage();
	const [note, setNote] = useState<ThreadNoteValue | null>(null);
	const [draft, setDraft] = useState("");
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setOpen(false);
		setEditing(false);
		setNote(null);
		setDraft("");
		setError(null);
		void authFetch(`/api/messages/${messageId}/note`)
			.then(async (response) => {
				const data = (await response.json()) as { note?: ThreadNoteValue | null };
				if (cancelled || !response.ok) return;
				setNote(data.note ?? null);
				setDraft(editorHtml(data.note?.body ?? ""));
				setOpen(!!data.note);
				setEditing(false);
			})
			.catch(() => {
				if (!cancelled) setError("failed");
			});
		return () => {
			cancelled = true;
		};
	}, [messageId]);

	async function save(html: string) {
		setSaving(true);
		setError(null);
		const keep = hasMeaningfulHtml(html);
		try {
			const response = await authFetch(`/api/messages/${messageId}/note`, {
				method: keep ? "PUT" : "DELETE",
				...(keep ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: html }) } : {}),
			});
			const data = (await response.json()) as { note?: ThreadNoteValue | null; error?: string };
			if (!response.ok) {
				setError(data.error === "Note is too long" ? t("note.tooLong") : t("note.failed"));
				return;
			}
			setNote(data.note ?? null);
			setDraft(editorHtml(data.note?.body ?? ""));
			setOpen(!!data.note);
			setEditing(false);
		} catch {
			setError(t("note.failed"));
		} finally {
			setSaving(false);
		}
	}

	function beginEdit() {
		setDraft(editorHtml(note?.body ?? ""));
		setEditing(true);
		setError(null);
	}

	function cancel() {
		setError(null);
		setDraft(editorHtml(note?.body ?? ""));
		setEditing(false);
		if (!note) setOpen(false);
	}

	if (!open) {
		return (
			<div className={cn("pb-2", className)}>
				<Tooltip label={t("note.add")}>
					<Button
						type="button"
						variant="ghost"
						size="roundedSM"
						aria-label={t("note.add")}
						onClick={() => {
							setDraft("");
							setOpen(true);
							setEditing(true);
							setError(null);
						}}
					>
						<StickyNote size={16} />
					</Button>
				</Tooltip>
				{error && <p className="px-3 pt-1 text-sm text-red-600">{error === "failed" ? t("note.failed") : error}</p>}
			</div>
		);
	}

	const savedHtml = editorHtml(note?.body ?? "");
	const unchanged = draft === savedHtml || (!note && !hasMeaningfulHtml(draft));
	const savedAt = note ? formatUserDate(note.updatedAt, { dateStyle: "medium", timeStyle: "short" }) : null;

	const quietButton = "rounded-full px-3 py-1 text-sm text-neutral-600 hover:bg-white/70 disabled:opacity-50";
	const solidButton = "rounded-full bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-40";

	return (
		<div className={cn("pb-4", className)}>
			<div className="overflow-hidden rounded-2xl border border-amber-200/80 bg-amber-50">
				{editing ? (
					<RichTextEditor
						id={`thread-note-${messageId}`}
						value={draft}
						onChange={setDraft}
						placeholder={t("note.placeholder")}
						label={t("note.add")}
						disabled={saving}
						bodyClassName="min-h-20 bg-transparent"
						className="bg-transparent"
					/>
				) : (
					<div
						data-note-read=""
						className="email-body min-h-20 break-words bg-transparent px-4 py-3 text-sm text-neutral-900"
						dangerouslySetInnerHTML={{ __html: savedHtml }}
					/>
				)}
				<div className="flex flex-wrap items-center gap-2 border-t border-amber-200/80 px-3 py-2">
					{note?.updatedByName && savedAt && (
						<p className="mr-auto text-xs text-amber-900/70">
							{t("note.savedBy", { name: note.updatedByName })}
							{" · "}
							{savedAt}
						</p>
					)}
					{!note?.updatedByName && <span className="mr-auto" />}
					{note && (
						<button type="button" onClick={() => void save("")} disabled={saving} className={quietButton}>
							{t("note.clear")}
						</button>
					)}
					{editing ? (
						<>
							<button type="button" onClick={cancel} disabled={saving} className={quietButton}>
								{t("note.cancel")}
							</button>
							<button type="button" onClick={() => void save(draft)} disabled={saving || unchanged} className={solidButton}>
								{t("note.save")}
							</button>
						</>
					) : (
						<button type="button" onClick={beginEdit} className={solidButton}>
							{t("note.edit")}
						</button>
					)}
				</div>
				{error && <p className="px-3 pb-2 text-sm text-red-600">{error === "failed" ? t("note.failed") : error}</p>}
			</div>
		</div>
	);
}
