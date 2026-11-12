"use client";

import { useEffect, useState } from "react";
import { ArrowDownToLine, Check, FileWarning, HardDrive } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useLanguage } from "@/components/language-provider";
import { useCurrentUser } from "@/hooks/use-current-user";
import { authFetch } from "@/lib/auth/client";
import { Skeleton } from "@/components/ui/skeleton";
import type { AttachmentRisk } from "@/lib/email/attachment-risk";
import type { MessageAttachmentViewerProps } from "./message-attachment-viewer-types";
import {
	getAttachmentFileUrl,
	getAttachmentPreviewKind,
} from "./message-attachment-viewer-utils";

export function MessageAttachmentViewer({
	attachment,
	messageId,
	onOpenChange,
	open,
}: MessageAttachmentViewerProps) {
	const { t } = useLanguage();
	const user = useCurrentUser();
	const [textContent, setTextContent] = useState("");
	const [textError, setTextError] = useState("");
	// Keyed by attachment id, so opening another file resets it without an effect.
	const [save, setSave] = useState<{ id: string; status: "saving" | "saved" | "error" } | null>(null);

	const previewKind = attachment ? getAttachmentPreviewKind(attachment) : "unsupported";
	const previewUrl = attachment
		? getAttachmentFileUrl(messageId, attachment.id, "preview")
		: "";
	const [risk, setRisk] = useState<AttachmentRisk | null>(null);
	const [acknowledged, setAcknowledged] = useState(false);
	const flagged = !!risk && risk.level !== "ok";
	const downloadUrl = attachment
		? getAttachmentFileUrl(messageId, attachment.id, flagged ? "acknowledged-download" : "download")
		: "";
	const saveState = save && save.id === attachment?.id ? save.status : "idle";

	// Reset per-attachment state while rendering, before the effects below refetch it.
	const [prevView, setPrevView] = useState({ attachment, messageId, open, t });
	if (attachment !== prevView.attachment || messageId !== prevView.messageId || open !== prevView.open || t !== prevView.t) {
		setPrevView({ attachment, messageId, open, t });
		if (attachment !== prevView.attachment || messageId !== prevView.messageId || open !== prevView.open) {
			setRisk(null);
			setAcknowledged(false);
		}
		if (open && attachment && previewKind === "text") {
			setTextContent("");
			setTextError("");
		}
	}

	useEffect(() => {
		if (!open || !attachment) return;
		let cancelled = false;
		void authFetch(getAttachmentFileUrl(messageId, attachment.id, "risk"))
			.then(async (response): Promise<AttachmentRisk | null> => (response.ok ? await response.json() : null))
			.then((data) => { if (!cancelled && data) setRisk(data); })
			.catch(() => undefined);
		return () => { cancelled = true; };
	}, [attachment, messageId, open]);

	useEffect(() => {
		if (!open || !attachment || previewKind !== "text") return;
		let cancelled = false;

		authFetch(previewUrl)
			.then(async (response) => {
				if (!response.ok) throw new Error(t("attachment.loadFailed"));
				const content = await response.text();
				if (!cancelled) setTextContent(content);
			})
			.catch((error) => {
				if (!cancelled) {
					setTextError(error instanceof Error ? error.message : t("attachment.loadFailed"));
				}
			});

		return () => {
			cancelled = true;
		};
	}, [attachment, open, previewKind, previewUrl, t]);

	// Ask once per opened attachment whether it is already in Drive, so the button starts disabled.
	useEffect(() => {
		if (!open || !attachment || user?.driveEnabled === false) return;
		const id = attachment.id;
		let cancelled = false;
		void authFetch(`/api/messages/${messageId}/attachments/${id}/save-to-drive`)
			.then(async (response) => (response.ok ? ((await response.json()) as { saved?: boolean }) : null))
			.then((data) => { if (!cancelled && data?.saved) setSave((current) => (current?.id === id && current.status === "saving" ? current : { id, status: "saved" })); })
			.catch(() => undefined);
		return () => { cancelled = true; };
	}, [attachment, messageId, open, user?.driveEnabled]);

	async function saveToDrive() {
		if (!attachment || saveState === "saving" || saveState === "saved") return;
		const id = attachment.id;
		setSave({ id, status: "saving" });
		try {
			const response = await authFetch(`/api/messages/${messageId}/attachments/${id}/save-to-drive`, { method: "POST" });
			if (!response.ok) throw new Error("Save to Drive failed");
			setSave({ id, status: "saved" });
		} catch {
			setSave({ id, status: "error" });
		}
	}

	if (!attachment) return null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex h-[min(88vh,900px)] w-[min(1100px,calc(100vw-32px))] flex-col overflow-hidden">
				<DialogHeader className="shrink-0 pr-10">
					<DialogTitle className="truncate">{attachment.filename}</DialogTitle>
					<DialogDescription>{attachment.type}</DialogDescription>
				</DialogHeader>

				<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg bg-neutral-100">
					{previewKind === "image" && (
						<img
							src={previewUrl}
							alt={attachment.filename}
							className="max-h-full max-w-full object-contain"
						/>
					)}
					{previewKind === "pdf" && (
						<iframe
							src={previewUrl}
							title={attachment.filename}
							className="h-full w-full border-0 bg-white"
						/>
					)}
					{previewKind === "audio" && (
						<audio src={previewUrl} controls className="w-[min(560px,90%)]" />
					)}
					{previewKind === "video" && (
						<video src={previewUrl} controls className="max-h-full max-w-full" />
					)}
					{previewKind === "text" && (
						textError || textContent ? (
							<pre className="h-full w-full overflow-auto whitespace-pre-wrap p-5 text-sm text-neutral-800">
								{textError || textContent}
							</pre>
						) : (
							<div className="h-full w-full space-y-3 bg-white p-5">
								<Skeleton className="h-4 w-full" />
								<Skeleton className="h-4 w-11/12" />
								<Skeleton className="h-4 w-4/5" />
							</div>
						)
					)}
					{previewKind === "unsupported" && (
						<div className="flex flex-col items-center gap-3 px-6 text-center">
							<FileWarning className="h-10 w-10 text-neutral-400" />
							<p className="text-sm text-neutral-600">
								{t("attachment.unsupported")}
							</p>
						</div>
					)}
				</div>

				{risk && flagged && (
					<div role="alert" className={`shrink-0 rounded-lg border p-3 text-sm ${risk.level === "blocked" ? "border-red-300 bg-red-50 text-red-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
						<p className="font-medium">{risk.level === "blocked" ? t("attachment.risk.blocked") : t("attachment.risk.warning")}</p>
						<ul className="mt-1 list-disc pl-5">
							{risk.reasons.map((reason) => <li key={reason}>{reason}</li>)}
						</ul>
						<label className="mt-2 flex items-center gap-2">
							<input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
							{t("attachment.risk.acknowledge")}
						</label>
					</div>
				)}

				<div className="flex shrink-0 items-center justify-end gap-3">
					{risk && !flagged && <span className="text-xs text-neutral-500">{t("attachment.risk.ok")}</span>}
					{saveState === "error" && <span className="text-xs text-red-600">{t("attachment.saveToDriveFailed")}</span>}
					{user?.driveEnabled !== false && (
						<Button
							variant="outline"
							onClick={() => void saveToDrive()}
							disabled={saveState === "saving" || saveState === "saved"}
						>
							{saveState === "saved" ? <Check className="h-4 w-4" /> : <HardDrive className="h-4 w-4" />}
							{saveState === "saved" ? t("attachment.savedToDrive") : saveState === "saving" ? t("common.saving") : t("attachment.saveToDrive")}
						</Button>
					)}
					{flagged && !acknowledged ? (
						<Button disabled>
							<ArrowDownToLine className="h-4 w-4" />
							{t("attachment.download")}
						</Button>
					) : (
						<Button asChild>
							<a href={downloadUrl} download={attachment.filename}>
								<ArrowDownToLine className="h-4 w-4" />
								{t("attachment.download")}
							</a>
						</Button>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
