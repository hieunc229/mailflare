"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Minimize2, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { cn } from "@/lib/utils";
import { fetchDraft } from "./utils";

type Toast = { type: "success" | "error"; message: string } | null;

export function ComposeForm({
	mode = "page",
	draftIdToLoad,
	onClose,
}: {
	mode?: "page" | "popup";
	draftIdToLoad?: string | null;
	onClose?: () => void;
}) {
	const { selectedMailbox, setSelectedMailbox, mailboxes } = useSelectedMailbox();
	const [draftId, setDraftId] = useState<string | null>(null);
	const [to, setTo] = useState("");
	const [subject, setSubject] = useState("");
	const [text, setText] = useState("");
	const [toast, setToast] = useState<Toast>(null);
	const [loading, setLoading] = useState(false);
	const [loadingDraft, setLoadingDraft] = useState(false);
	const [loadedDraftMailboxId, setLoadedDraftMailboxId] = useState<string | null>(null);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const fromAddr = useMemo(
		() => (selectedMailbox ? `${selectedMailbox.localPart}@${selectedMailbox.hostname}` : ""),
		[selectedMailbox],
	);

	useEffect(() => {
		if (!toast) return;
		const timer = setTimeout(() => setToast(null), 3200);
		return () => clearTimeout(timer);
	}, [toast]);

	useEffect(() => {
		if (!draftIdToLoad) return;

		let cancelled = false;
		setLoadingDraft(true);
		fetchDraft(draftIdToLoad)
			.then((draft) => {
				if (cancelled) return;

				setDraftId(draft.id);
				setTo(draft.toAddr);
				setSubject(draft.subject ?? "");
				setText(draft.textBody ?? "");
				setLoadedDraftMailboxId(draft.mailboxId);
			})
			.catch((err) => {
				if (cancelled) return;
				const message = err instanceof Error ? err.message : "Failed to load draft";
				setToast({ type: "error", message });
			})
			.finally(() => {
				if (!cancelled) setLoadingDraft(false);
			});

		return () => {
			cancelled = true;
		};
	}, [draftIdToLoad]);

	useEffect(() => {
		if (!loadedDraftMailboxId) return;

		const draftMailbox = mailboxes.find((mailbox) => mailbox.id === loadedDraftMailboxId);
		if (draftMailbox) setSelectedMailbox(draftMailbox);
	}, [loadedDraftMailboxId, mailboxes, setSelectedMailbox]);

	useEffect(() => {
		const hasContent = to.trim() || subject.trim() || text.trim();
		if (!fromAddr || !hasContent || loadingDraft) return;
		if (saveTimer.current) clearTimeout(saveTimer.current);

		saveTimer.current = setTimeout(async () => {
			const payload = {
				mailboxId: selectedMailbox?.id,
				from: fromAddr,
				to,
				subject,
				text,
			};
			const res = await fetch(draftId ? `/api/drafts/${draftId}` : "/api/drafts", {
				method: draftId ? "PATCH" : "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const data = (await res.json()) as { draft?: { id: string } };
			if (res.ok && data.draft?.id) setDraftId(data.draft.id);
		}, 900);

		return () => {
			if (saveTimer.current) clearTimeout(saveTimer.current);
		};
	}, [draftId, fromAddr, loadingDraft, selectedMailbox?.id, subject, text, to]);

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setLoading(true);
		const res = await fetch("/api/send", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				from: fromAddr,
				to,
				subject,
				text,
				mailboxId: selectedMailbox?.id,
			}),
		});
		const data = (await res.json()) as { messageId?: string; error?: string };
		setLoading(false);

		if (!res.ok) {
			setToast({ type: "error", message: data.error ?? "Send failed" });
			return;
		}

		if (draftId) {
			void fetch(`/api/drafts/${draftId}`, { method: "DELETE" }).finally(() => {
				window.dispatchEvent(new Event("mailflare:messages-changed"));
			});
		}
		setDraftId(null);
		setTo("");
		setSubject("");
		setText("");
		setToast({ type: "success", message: "Message sent" });
		window.dispatchEvent(new Event("mailflare:messages-changed"));
	}

	const frameClass =
		mode === "popup"
			? "fixed bottom-4 right-4 z-40 flex h-[min(520px,calc(100vh-88px))] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-2xl"
			: "flex h-full min-h-[720px] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm";

	return (
		<>
			{toast && (
				<div
					className={cn(
						"fixed right-6 top-6 z-50 rounded-lg px-4 py-3 text-sm font-medium shadow-lg",
						toast.type === "success" ? "bg-green-600 text-white" : "bg-red-600 text-white",
					)}
				>
					{toast.message}
				</div>
			)}
			<form onSubmit={onSubmit} className={frameClass}>
				<div className="flex h-9 items-center justify-between bg-neutral-800 px-4 text-sm font-medium text-white">
					<span>{loadingDraft ? "Loading draft" : draftId ? "Draft saved" : "New Message"}</span>
					{mode === "popup" && (
						<div className="flex items-center gap-3 text-neutral-300">
							<Minimize2 className="h-4 w-4" />
							<button type="button" onClick={onClose}>
								<X className="h-4 w-4" />
							</button>
						</div>
					)}
				</div>
				<div className="border-b border-neutral-100 px-4 py-1">
					<Label htmlFor={`${mode}-from`} className="sr-only">From</Label>
					<Input
						id={`${mode}-from`}
						value={fromAddr}
						placeholder="Select a mailbox first"
						readOnly
						required
						className="h-8 border-0 px-0 py-1 shadow-none focus-visible:ring-0"
					/>
				</div>
				<div className="border-b border-neutral-100 px-4 py-1">
					<Label htmlFor={`${mode}-to`} className="sr-only">To</Label>
					<Input
						id={`${mode}-to`}
						value={to}
						onChange={(event) => setTo(event.target.value)}
						type="email"
						placeholder="Recipients"
						required
						disabled={loadingDraft}
						className="h-8 border-0 px-0 py-1 shadow-none focus-visible:ring-0"
					/>
				</div>
				<div className="border-b border-neutral-100 px-4 py-1">
					<Label htmlFor={`${mode}-subject`} className="sr-only">Subject</Label>
					<Input
						id={`${mode}-subject`}
						value={subject}
						onChange={(event) => setSubject(event.target.value)}
						placeholder="Subject"
						required
						disabled={loadingDraft}
						className="h-8 border-0 px-0 py-1 shadow-none focus-visible:ring-0"
					/>
				</div>
				<div className="min-h-0 flex-1 px-4 py-2">
					<Label htmlFor={`${mode}-text`} className="sr-only">Body</Label>
					<Textarea
						id={`${mode}-text`}
						value={text}
						onChange={(event) => setText(event.target.value)}
						required
						disabled={loadingDraft}
						className="h-full min-h-full resize-none border-0 px-0 shadow-none focus-visible:ring-0"
					/>
				</div>
				<div className="flex items-center gap-3 border-t border-neutral-100 px-4 py-3">
					<span className="flex-1" />
					<p className="text-xs text-neutral-500">{draftId ? "Saved to drafts" : "Autosaves as draft"}</p>
					<Button type="submit" disabled={loading || loadingDraft || !fromAddr} className="rounded-full px-5">
						<Send className="h-4 w-4" />
						{loading ? "Sending" : "Send"}
					</Button>
				</div>
			</form>
		</>
	);
}
