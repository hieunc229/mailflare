"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { BellRing, ChevronUp, Eye, EyeOff, FileText, Forward, Maximize2, Minimize2, Minus, Paperclip, Reply, Trash2, X } from "@/components/icons";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { authFetch } from "@/lib/auth/client";
import { formatEmailAddress, getEmailAddress } from "@/lib/email/address";
import { clearMessageDetailCache } from "@/lib/messages/detail-cache";
import { useCompose } from "@/components/compose/compose-context";
import { cn } from "@/lib/utils";
import { SendReview } from "@/components/agent/send-review";
import type { ReviewSnapshot } from "@/components/agent/send-review-types";
import { useIsMobile } from "@/components/sidebar-mobile-utils";
import { useSheetViewport } from "./use-sheet-viewport";
import { useTrackOpens } from "./use-track-opens";
import { FollowUpMenu } from "@/components/follow-ups/follow-up-menu";
import { followUpOptionKey } from "@/components/follow-ups/follow-up-client-utils";
import { formatScheduledSendTime } from "@/components/messages/scheduled-send-utils";
import { buildSendFormData, fetchDraft, formatAttachmentSize } from "./utils";
import { RecipientInput } from "./recipient-input";
import { RichTextEditor } from "./rich-text-editor";
import { ScheduleSendMenu } from "./schedule-send-menu";
import { isPastSchedule } from "./schedule-send-utils";
import { DELIVERY_WAIT_MS, SCHEDULED_NOTICE_MS, SENT_NOTICE_MS, resolveSendNotice, splitSendTemplate } from "./send-notice-utils";
import type { SendNoticeParts, SendResult } from "./send-notice-utils";
import {
	applyMailboxSignatureHtml,
	hasMeaningfulHtml,
	htmlToPlainText,
	joinQuotedHtml,
	splitQuotedHtml,
	textToHtml,
} from "./rich-text-utils";
import { headerToRecipients, isValidRecipient, recipientsToHeader } from "./recipient-utils";
import type { ComposeAttachment, ComposeStoredAttachment, ComposeThreading } from "./types";
import type { ComposeAttachmentPolicy } from "./attachment-policy-types";

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
	const { t } = useLanguage();
	const router = useRouter();
	const { showNotice, openDraftComposer, isCurrentNotice } = useCompose();
	const { selectedMailbox, setSelectedMailbox, mailboxes } = useSelectedMailbox();
	const [draftId, setDraftId] = useState<string | null>(null);
	const [agentRevision, setAgentRevision] = useState<number | null>(null);
	const [agentReview, setAgentReview] = useState<{ approvalId: string; snapshot: ReviewSnapshot } | null>(null);
	const [to, setTo] = useState<string[]>([]);
	const [cc, setCc] = useState<string[]>([]);
	const [bcc, setBcc] = useState<string[]>([]);
	const [showCc, setShowCc] = useState(false);
	const [showBcc, setShowBcc] = useState(false);
	const [threading, setThreading] = useState<ComposeThreading | null>(null);
	const [subject, setSubject] = useState("");
	// The body is HTML; quoted/forwarded content is kept aside and folded.
	const [html, setHtml] = useState("");
	const [quotedHtml, setQuotedHtml] = useState<string | null>(null);
	const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
	// Attachments the draft already holds server-side (a forwarded message's files).
	const [storedAttachments, setStoredAttachments] = useState<ComposeStoredAttachment[]>([]);
	const [attachmentPolicy, setAttachmentPolicy] = useState<ComposeAttachmentPolicy>({ maxMb: 25, cloudThresholdBytes: 3_000_000 });
	const [draggingFiles, setDraggingFiles] = useState(false);
	const [modalMode, setModalMode] = useState(false);
	const [minimized, setMinimized] = useState(false);
	const [toast, setToast] = useState<Toast>(null);
	const [loading, setLoading] = useState(false);
	const [loadingDraft, setLoadingDraft] = useState(false);
	const [deletingDraft, setDeletingDraft] = useState(false);
	const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
	const [trackOpens, setTrackOpens] = useTrackOpens();
	const [followUpDays, setFollowUpDays] = useState<number | null>(null);
	const [loadedDraftMailboxId, setLoadedDraftMailboxId] = useState<string | null>(null);
	const [loadedDraftFrom, setLoadedDraftFrom] = useState<string | null>(null);
	const [selectedFrom, setSelectedFrom] = useState("");
	const formRef = useRef<HTMLFormElement>(null);
	useSheetViewport(formRef, mode === "popup");
	const isPhone = useIsMobile();
	const phoneSheet = mode === "popup" && isPhone;
	const [closing, setClosing] = useState(false);
	const dragStart = useRef<number | null>(null);
	const [dragY, setDragY] = useState(0);
	const noticeActionInFlight = useRef(false);

	// Phones: slide the sheet away and let the page behind grow back before unmounting.
	function dismiss() {
		if (!onClose) return;
		if (!phoneSheet || closing) { onClose(); return; }
		setClosing(true);
		window.setTimeout(onClose, 260);
	}

	const sheetDrag = phoneSheet ? {
		onTouchStart: (event: React.TouchEvent) => { dragStart.current = event.touches[0].clientY; },
		onTouchMove: (event: React.TouchEvent) => {
			if (dragStart.current !== null) setDragY(Math.max(0, event.touches[0].clientY - dragStart.current));
		},
		onTouchEnd: () => {
			dragStart.current = null;
			if (dragY > 110) dismiss();
			setDragY(0);
		},
	} : {};
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingSave = useRef<(() => Promise<void>) | null>(null);
	const draftGeneration = useRef(0);
	const draftIdRef = useRef<string | null>(null);
	const agentRevisionRef = useRef(agentRevision);
	useEffect(() => {
		agentRevisionRef.current = agentRevision;
	}, [agentRevision]);
	// A pending human send review owns this snapshot. Autosaving after creating
	// an approval increments its revision and makes confirmation impossible.
	const reviewInProgressRef = useRef(false);
	const saveQueue = useRef<Promise<void>>(Promise.resolve());
	const uploadedFiles = useRef(new WeakSet<File>());
	const rejectedFiles = useRef(new WeakSet<File>());
	const attachmentInput = useRef<HTMLInputElement | null>(null);
	const fileDragDepth = useRef(0);
	const previousSignature = useRef("");

	useEffect(() => {
		if (!selectedMailbox && mailboxes.length === 1) setSelectedMailbox(mailboxes[0]);
	}, [mailboxes, selectedMailbox, setSelectedMailbox]);

	useEffect(() => {
		let active = true;
		void authFetch("/api/attachment-policy", { cache: "no-store" }).then(async (response) => {
			if (response.ok && active) setAttachmentPolicy((await response.json()) as ComposeAttachmentPolicy);
		}).catch(() => {});
		return () => { active = false; };
	}, []);

	const senderAddresses = useMemo(() => {
		if (!selectedMailbox) return [];
		return selectedMailbox.senderAddresses?.length
			? selectedMailbox.senderAddresses
			: [`${selectedMailbox.localPart}@${selectedMailbox.hostname}`];
	}, [selectedMailbox]);
	const senderOptions = useMemo(
		() => mailboxes.flatMap((mailbox) => {
			const addresses = mailbox.senderAddresses?.length
				? mailbox.senderAddresses
				: [`${mailbox.localPart}@${mailbox.hostname}`];
			return addresses.map((address) => ({ mailbox, address }));
		}),
		[mailboxes],
	);
	const fromAddr = selectedMailbox && selectedFrom
		? formatEmailAddress(selectedFrom, selectedMailbox.displayName)
		: "";

	useEffect(() => {
		if (!senderAddresses.length) {
			setSelectedFrom("");
			return;
		}
		if (!senderAddresses.includes(selectedFrom)) setSelectedFrom(senderAddresses[0]);
	}, [selectedFrom, senderAddresses]);

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

				draftIdRef.current = draft.id;
				setDraftId(draft.id);
				setAgentRevision(draft.agent?.revision ?? null);
				setScheduledAt(draft.agent?.scheduledAt ? new Date(draft.agent.scheduledAt) : null);
				setTo(headerToRecipients(draft.toAddr));
				const draftCc = headerToRecipients(draft.ccAddr);
				const draftBcc = headerToRecipients(draft.bccAddr);
				setCc(draftCc);
				setBcc(draftBcc);
				setShowCc(draftCc.length > 0);
				setShowBcc(draftBcc.length > 0);
				setThreading(
					draft.inReplyTo || draft.threadId
						? {
							inReplyTo: draft.inReplyTo ?? null,
							references: draft.references ?? null,
							threadId: draft.threadId ?? null,
						}
						: null,
				);
				setSubject(draft.subject ?? "");
				const stored = splitQuotedHtml(draft.htmlBody || textToHtml(draft.textBody));
				setHtml(stored.body);
				setQuotedHtml(stored.quoted);
				setStoredAttachments(draft.attachments?.filter((item) => item.disposition === "attachment") ?? []);
				setLoadedDraftMailboxId(draft.mailboxId);
				setLoadedDraftFrom(getEmailAddress(draft.fromAddr).toLowerCase());
			})
			.catch((err) => {
				if (cancelled) return;
				const message = err instanceof Error ? err.message : t("compose.error.loadDraft");
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
		if (selectedMailbox?.id === loadedDraftMailboxId) return;

		const draftMailbox = mailboxes.find((mailbox) => mailbox.id === loadedDraftMailboxId);
		if (draftMailbox) setSelectedMailbox(draftMailbox);
	}, [loadedDraftMailboxId, mailboxes, selectedMailbox?.id, setSelectedMailbox]);

	useEffect(() => {
		if (!loadedDraftFrom || !senderAddresses.includes(loadedDraftFrom)) return;
		setSelectedFrom(loadedDraftFrom);
	}, [loadedDraftFrom, senderAddresses]);

	useEffect(() => {
		if (loadingDraft) return;
		const nextSignature = selectedMailbox?.signature ?? "";
		setHtml((current) => applyMailboxSignatureHtml(current, previousSignature.current, nextSignature));
		previousSignature.current = nextSignature;
	}, [loadingDraft, selectedMailbox?.id, selectedMailbox?.signature]);

	useEffect(() => () => {
		void pendingSave.current?.();
	}, []);

	useEffect(() => {
		pendingSave.current = null;
		const bodyContent = htmlToPlainText(html).trim();
		const signatureOnly = bodyContent === (selectedMailbox?.signature?.trim() ?? "");
		const hasContent =
			to.length > 0 || cc.length > 0 || bcc.length > 0 || subject.trim() || quotedHtml || attachments.length > 0 || (bodyContent && !signatureOnly);
		if (!fromAddr || !hasContent || loadingDraft || reviewInProgressRef.current) return;
		if (saveTimer.current) clearTimeout(saveTimer.current);

		const generation = draftGeneration.current;
		const save = () => {
			const run = saveQueue.current.then(async () => {
				if (generation !== draftGeneration.current || reviewInProgressRef.current) return;
				const payload = {
					mailboxId: selectedMailbox?.id,
					from: fromAddr,
					to: recipientsToHeader(to),
					cc: recipientsToHeader(cc),
					bcc: recipientsToHeader(bcc),
					subject,
					html: joinQuotedHtml(html, quotedHtml),
					text: htmlToPlainText(joinQuotedHtml(html, quotedHtml)),
					inReplyTo: threading?.inReplyTo ?? null,
					references: threading?.references ?? null,
					threadId: threading?.threadId ?? null,
				};
				const existingId = draftIdRef.current;
				const res = await authFetch(existingId ? `/api/drafts/${existingId}` : "/api/drafts", {
					method: existingId ? "PATCH" : "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				});
				const data = (await res.json()) as { draft?: { id: string } };
				if (!res.ok || !data.draft?.id) return;
				if (generation !== draftGeneration.current) {
					if (!existingId) void authFetch(`/api/drafts/${data.draft.id}`, { method: "DELETE" });
					return;
				}
				draftIdRef.current = data.draft.id;
				setDraftId(data.draft.id);
				const pending = attachments.filter((attachment) => !uploadedFiles.current.has(attachment.file) && !rejectedFiles.current.has(attachment.file));
				if (agentRevisionRef.current !== null || pending.length === 0) return;
				const form = new FormData();
				for (const attachment of pending) form.append("attachments", attachment.file);
				const uploaded = await authFetch(`/api/drafts/${data.draft.id}/attachments`, { method: "POST", body: form });
				const result = (await uploaded.json()) as { attachments?: ComposeStoredAttachment[]; error?: string };
				if (!uploaded.ok) {
					for (const attachment of pending) rejectedFiles.current.add(attachment.file);
					setToast({ type: "error", message: result.error || t("compose.error.draftAttachments") });
					return;
				}
				for (const attachment of pending) uploadedFiles.current.add(attachment.file);
				setStoredAttachments((current) => [...current, ...(result.attachments ?? [])]);
				setAttachments((current) => current.filter((attachment) => !uploadedFiles.current.has(attachment.file)));
			}).catch(() => {});
			saveQueue.current = run;
			return run;
		};
		pendingSave.current = save;
		saveTimer.current = setTimeout(() => {
			pendingSave.current = null;
			void save();
		}, 900);

		return () => {
			if (saveTimer.current) clearTimeout(saveTimer.current);
		};
	}, [attachments, bcc, cc, fromAddr, html, loadingDraft, quotedHtml, selectedMailbox?.id, selectedMailbox?.signature, subject, threading, to]);

	useEffect(() => {
		if (!draftIdToLoad || loadingDraft) return;
		formRef.current?.querySelector<HTMLElement>("[contenteditable='true']")?.focus();
	}, [draftIdToLoad, loadingDraft]);

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (to.length === 0) {
			setToast({ type: "error", message: t("compose.error.noRecipient") });
			return;
		}
		const invalid = [...to, ...cc, ...bcc].find((entry) => !isValidRecipient(entry));
		if (invalid) {
			setToast({ type: "error", message: t("compose.error.invalidAddress", { address: invalid }) });
			return;
		}
		if (!hasMeaningfulHtml(html) && !quotedHtml) {
			setToast({ type: "error", message: t("compose.error.emptyBody") });
			return;
		}
		if (scheduledAt && isPastSchedule(scheduledAt)) {
			setToast({ type: "error", message: t("schedule.pastTime") });
			return;
		}
		// Freeze autosave for an AI draft before waiting for any queued save.
		// Otherwise a debounced PATCH can invalidate the approval snapshot.
		if (draftId && agentRevision !== null) reviewInProgressRef.current = true;
		if (saveTimer.current) clearTimeout(saveTimer.current);
		pendingSave.current = null;
		setLoading(true);
		await saveQueue.current;
		const currentDraftId = draftIdRef.current;
		const unsentAttachments = attachments.filter((attachment) => !uploadedFiles.current.has(attachment.file));
		const fullHtml = joinQuotedHtml(html, quotedHtml);
		if (draftId && agentRevision !== null) {
			try {
				if (saveTimer.current) clearTimeout(saveTimer.current);
				if (attachments.length > 0) {
					const form = new FormData();
					for (const attachment of attachments) form.append("attachments", attachment.file);
					const uploaded = await authFetch(`/api/drafts/${draftId}/attachments`, { method: "POST", body: form });
					const result = await uploaded.json() as { attachments?: ComposeStoredAttachment[]; error?: string };
					if (!uploaded.ok) throw new Error(result.error || t("compose.error.draftAttachments"));
					setStoredAttachments((current) => [...current, ...(result.attachments ?? [])]);
					setAttachments([]);
				}
				const updated = await authFetch(`/api/drafts/${draftId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId: selectedMailbox?.id, from: fromAddr, to: recipientsToHeader(to), cc: recipientsToHeader(cc), bcc: recipientsToHeader(bcc), subject, html: fullHtml, text: htmlToPlainText(fullHtml), inReplyTo: threading?.inReplyTo ?? null, references: threading?.references ?? null, threadId: threading?.threadId ?? null, scheduledAt: scheduledAt?.toISOString() ?? null }) });
				if (!updated.ok) throw new Error(t("compose.error.saveForReview"));
				const current = await fetchDraft(draftId);
				if (!current.agent) throw new Error(t("compose.error.aiMetadata"));
				setAgentRevision(current.agent.revision);
				const response = await authFetch("/api/agent/approvals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId, expectedRevision: current.agent.revision }) });
				const result = await response.json() as { approvalId?: string; snapshot?: ReviewSnapshot; error?: string };
				if (!response.ok || !result.approvalId || !result.snapshot) throw new Error(result.error || t("compose.error.createReview"));
				setAgentReview({ approvalId: result.approvalId, snapshot: result.snapshot });
			} catch (cause) {
				reviewInProgressRef.current = false;
				setToast({ type: "error", message: cause instanceof Error ? cause.message : t("compose.error.reviewDraft") });
			}
			finally { setLoading(false); }
			return;
		}
		let res: Response;
		let data: SendResult & { error?: string };
		try {
			res = await authFetch("/api/send", {
				method: "POST",
				body: buildSendFormData({
					attachments: unsentAttachments,
					from: fromAddr,
					to: recipientsToHeader(to),
					cc: recipientsToHeader(cc),
					bcc: recipientsToHeader(bcc),
					subject,
					text: htmlToPlainText(fullHtml),
					html: fullHtml,
					mailboxId: selectedMailbox?.id,
					threading: threading ?? undefined,
					draftId,
					scheduledAt,
					undoSend: true,
					trackOpens,
					followUpDays,
				}),
			});
			data = (await res.json()) as SendResult & { error?: string };
		} catch {
			setLoading(false);
			setToast({ type: "error", message: t("compose.error.sendFailed") });
			return;
		}
		setLoading(false);

		if (!res.ok) {
			setToast({ type: "error", message: data.error ?? t("compose.error.sendFailed") });
			return;
		}

		// With a draft, refresh once it is gone so the lists reload a single time.
		const refreshLists = () => window.dispatchEvent(new Event("mailflare:messages-changed"));
		if (currentDraftId) void authFetch(`/api/drafts/${currentDraftId}`, { method: "DELETE" }).finally(refreshLists);
		draftGeneration.current += 1;
		draftIdRef.current = null;
		setDraftId(null);
		setTo([]);
		setCc([]);
		setBcc([]);
		setShowCc(false);
		setShowBcc(false);
		setThreading(null);
		setStoredAttachments([]);
		setSubject("");
		setHtml(applyMailboxSignatureHtml("", "", selectedMailbox?.signature));
		setQuotedHtml(null);
		setAttachments([]);
		setScheduledAt(null);
		const notice = resolveSendNotice(data);
		const subjectLabel = subject.trim() || t("list.noSubject");
		if (notice.kind === "undo") {
			const content = buildSubjectNotice("compose.sendingIn", subjectLabel, notice.messageId, true);
			let undoNoticeId = 0;
			// The send is queued for the undo window; Undo returns it to Drafts and Send now skips the wait.
			undoNoticeId = showNotice(content.message, {
				parts: content.parts,
				durationMs: notice.durationMs,
				countdown: { endAt: notice.endAt },
				// Delivery starts after the window; keep watching until the queue reports a result.
				onCountdownEnd: () => {
					if (!isCurrentNotice(undoNoticeId) || noticeActionInFlight.current) return;
					showSendingNotice(notice.messageId, subjectLabel);
				},
				actions: [
					{ label: t("compose.undoSend"), onClick: () => cancelSend(notice.messageId, "undo", undoNoticeId) },
					{ label: t("compose.sendNow"), onClick: () => sendNow(notice.messageId, subjectLabel, undoNoticeId) },
				],
			}) ?? 0;
		} else if (notice.kind === "sending") {
			showSendingNotice(notice.messageId, subjectLabel);
		} else if (notice.kind === "scheduled") {
			const message = notice.scheduledAt
				? t("schedule.sendScheduledFor", { when: formatScheduledSendTime(notice.scheduledAt, t) })
				: t("compose.scheduled");
			let scheduledNoticeId = 0;
			scheduledNoticeId = showNotice(message, {
				durationMs: SCHEDULED_NOTICE_MS,
				actions: [{ label: t("schedule.cancelSend"), onClick: () => cancelSend(notice.messageId, "scheduled", scheduledNoticeId) }],
			}) ?? 0;
		} else {
			showNotice(t("compose.sent"));
		}
		if (!currentDraftId) refreshLists();

		if (onClose) {
			dismiss();
			return;
		}
		router.push("/sent");
	}

	/**
	 * Splits a translated template around {subject} so the subject can link to the
	 * message, and around {seconds} so only the ticking suffix changes. Passing the
	 * placeholders back as values leaves them intact for the split.
	 *
	 * A message that is still queued is listed under Scheduled; only a delivered one
	 * lives in Sent, so the link follows the message's state.
	 */
	function buildSubjectNotice(
		key: "compose.sendingIn" | "compose.sendingSubject" | "compose.sentSubject",
		subjectLabel: string,
		messageId: string,
		countdown: boolean,
	): { message: string; parts: SendNoticeParts } {
		const template = t(key, { subject: "{subject}", seconds: "{seconds}" });
		const href = key === "compose.sentSubject" ? `/sent/${messageId}` : `/scheduled/${messageId}`;
		const parts: SendNoticeParts = {
			...splitSendTemplate(template, countdown),
			link: { label: subjectLabel, href },
		};
		return { message: t(key, { subject: subjectLabel, seconds: 1 }), parts };
	}

	/** Shows the message while the queue delivers it and watches for the final status. */
	function showSendingNotice(messageId: string, subjectLabel: string): number {
		const content = buildSubjectNotice("compose.sendingSubject", subjectLabel, messageId, false);
		let noticeId = 0;
		noticeId = showNotice(content.message, {
			parts: content.parts,
			durationMs: DELIVERY_WAIT_MS,
			poll: {
				messageId,
				onStatus: (status) => {
					if (status === "sent") {
						// Delivered: refresh the lists even if a newer toast has taken over.
						showSentNotice(messageId, subjectLabel, noticeId);
						return;
					}
					if (!isCurrentNotice(noticeId)) return;
					if (status === "failed") showNotice(t("compose.error.sendFailed"), { tone: "error" });
					else showNotice(null);
				},
			},
		}) ?? 0;
		return noticeId;
	}

	function showSentNotice(messageId: string, subjectLabel: string, sourceNoticeId: number) {
		// The message is delivered, so the lists and the cached detail are stale
		// whichever toast is on screen; refresh them before the notice check.
		clearMessageDetailCache();
		window.dispatchEvent(new Event("mailflare:messages-changed"));
		if (!isCurrentNotice(sourceNoticeId)) return;
		const content = buildSubjectNotice("compose.sentSubject", subjectLabel, messageId, false);
		showNotice(content.message, { parts: content.parts, durationMs: SENT_NOTICE_MS });
	}

	async function sendNow(messageId: string, subjectLabel: string, sourceNoticeId: number) {
		if (noticeActionInFlight.current) return;
		noticeActionInFlight.current = true;
		try {
			const response = await authFetch(`/api/messages/${messageId}/send-now`, { method: "POST" });
			if (response.ok) {
				// The message is on its way: refresh the lists even if a newer toast has taken over.
				showSentNotice(messageId, subjectLabel, sourceNoticeId);
				return;
			}
			if (!isCurrentNotice(sourceNoticeId)) return;
			if (response.status === 409) {
				// The queued delivery claimed the message first; watch it instead of failing.
				showSendingNotice(messageId, subjectLabel);
				return;
			}
			if (response.status >= 500) {
				// The request may have failed before claiming the job; the scheduled send can
				// still deliver later, so let the status poll decide instead of reporting failure.
				showSendingNotice(messageId, subjectLabel);
				return;
			}
			const result = await response.json().catch(() => ({})) as { error?: string };
			if (!isCurrentNotice(sourceNoticeId)) return;
			showNotice(result.error ?? t("compose.error.sendFailed"), { tone: "error" });
		} catch {
			// A dropped response is ambiguous: the message may still be on its way.
			if (isCurrentNotice(sourceNoticeId)) showSendingNotice(messageId, subjectLabel);
		} finally {
			noticeActionInFlight.current = false;
		}
	}

	async function cancelSend(messageId: string, source: "undo" | "scheduled", sourceNoticeId: number) {
		if (noticeActionInFlight.current) return;
		noticeActionInFlight.current = true;
		try {
			const res = await authFetch(`/api/messages/${messageId}/cancel-schedule`, { method: "POST" });
			if (!res.ok) {
				if (!isCurrentNotice(sourceNoticeId)) return;
				// A 409 on the undo toast means the queue claimed it; a scheduled send can also fail for other reasons.
				showNotice(source === "undo" && res.status === 409 ? t("compose.cancelTooLate") : t("schedule.cancelFailed"), {
					tone: "error",
				});
				return;
			}
			// The message is back in Drafts, so the lists and the cached detail are
			// stale whichever toast is on screen; refresh them before the notice check.
			clearMessageDetailCache();
			window.dispatchEvent(new Event("mailflare:messages-changed"));
			if (!isCurrentNotice(sourceNoticeId)) return;
			showNotice(t("compose.sendCancelled"));
			openDraftComposer(messageId);
		} catch {
			if (isCurrentNotice(sourceNoticeId)) showNotice(t("schedule.cancelFailed"), { tone: "error" });
		} finally {
			noticeActionInFlight.current = false;
		}
	}

	async function deleteDraftAndClose() {
		if (saveTimer.current) clearTimeout(saveTimer.current);
		pendingSave.current = null;
		draftGeneration.current += 1;
		setDeletingDraft(true);
		await saveQueue.current;

		if (draftIdRef.current) {
			let deleted = false;
			try {
				const res = await authFetch(`/api/drafts/${draftIdRef.current}`, { method: "DELETE" });
				deleted = res.ok || res.status === 404;
			} catch {
				deleted = false;
			}
			if (!deleted) {
				setDeletingDraft(false);
				setToast({ type: "error", message: t("compose.error.deleteDraft") });
				return;
			}
		}

		draftIdRef.current = null;
		setDraftId(null);
		setTo([]);
		setCc([]);
		setBcc([]);
		setShowCc(false);
		setShowBcc(false);
		setThreading(null);
		setStoredAttachments([]);
		setSubject("");
		setHtml(applyMailboxSignatureHtml("", "", selectedMailbox?.signature));
		setQuotedHtml(null);
		setAttachments([]);
		setScheduledAt(null);
		window.dispatchEvent(new Event("mailflare:messages-changed"));

		if (onClose) {
			dismiss();
			return;
		}
		setDeletingDraft(false);
		router.push("/inbox");
	}

	async function removeStoredAttachment(attachmentId: string) {
		const currentDraftId = draftIdRef.current;
		if (!currentDraftId) return;
		const res = await authFetch(`/api/drafts/${currentDraftId}/attachments/${attachmentId}`, { method: "DELETE" });
		if (!res.ok) {
			setToast({ type: "error", message: t("compose.error.removeAttachment") });
			return;
		}
		setStoredAttachments((current) => current.filter((item) => item.id !== attachmentId));
	}

	function addAttachments(files: FileList | null) {
		if (!files) return;
		const nextFiles = Array.from(files);
		const nextCount = storedAttachments.length + attachments.length + nextFiles.length;
		const totalSize =
			storedAttachments.reduce((total, item) => total + item.size, 0) +
			[...attachments.map((attachment) => attachment.file), ...nextFiles].reduce(
				(total, file) => total + file.size,
				0,
			);

		if (nextCount > 10) {
			setToast({ type: "error", message: t("compose.error.maxAttachments") });
			return;
		}
		if (nextFiles.some((file) => file.size > attachmentPolicy.maxMb * 1_000_000)) {
			setToast({ type: "error", message: t("compose.error.attachmentSize", { max: attachmentPolicy.maxMb }) });
			return;
		}
		if (totalSize > attachmentPolicy.maxMb * 1_000_000) {
			setToast({ type: "error", message: t("compose.error.totalSize", { max: attachmentPolicy.maxMb }) });
			return;
		}

		setAttachments((current) => [
			...current,
			...nextFiles.map((file) => ({ id: crypto.randomUUID(), file })),
		]);
		if (attachmentInput.current) attachmentInput.current.value = "";
	}

	function onFileDragEnter(event: DragEvent<HTMLFormElement>) {
		if (!event.dataTransfer.types.includes("Files")) return;
		fileDragDepth.current += 1;
		if (!loading && !loadingDraft) setDraggingFiles(true);
	}

	function onFileDragOver(event: DragEvent<HTMLFormElement>) {
		if (!event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = loading || loadingDraft ? "none" : "copy";
	}

	function onFileDragLeave(event: DragEvent<HTMLFormElement>) {
		if (!event.dataTransfer.types.includes("Files")) return;
		fileDragDepth.current = Math.max(0, fileDragDepth.current - 1);
		if (fileDragDepth.current === 0) setDraggingFiles(false);
	}

	function onFileDrop(event: DragEvent<HTMLFormElement>) {
		if (!event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		fileDragDepth.current = 0;
		setDraggingFiles(false);
		if (!loading && !loadingDraft) addAttachments(event.dataTransfer.files);
	}

	function selectSender(value: string) {
		const option = senderOptions.find((item) => `${item.mailbox.id}|${item.address}` === value);
		if (!option) return;
		setSelectedFrom(option.address);
		if (selectedMailbox?.id !== option.mailbox.id) setSelectedMailbox(option.mailbox);
	}

	const attachmentContent = (attachments.length > 0 || storedAttachments.length > 0) && (
		<div>
		<div className="flex min-w-0 flex-nowrap gap-2 overflow-x-auto overflow-y-hidden px-3 py-2">
			{storedAttachments.map((attachment) => (
				<div
					key={attachment.id}
					className="flex max-w-full shrink-0 items-center gap-2 rounded-lg bg-neutral-100 px-2 py-1 text-xs"
					title={t("compose.carriedOver")}
				>
					<FileText className="h-4 w-4 shrink-0 text-neutral-500" />
					<span className="max-w-48 truncate">{attachment.filename}</span>
					<span className="text-xs text-neutral-500">{formatAttachmentSize(attachment.size)}</span>
					<button
						type="button"
						onClick={() => void removeStoredAttachment(attachment.id)}
						className="rounded-full p-1 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700"
					>
						<X className="h-3.5 w-3.5" />
						<span className="sr-only">{t("compose.removeAttachment")}</span>
					</button>
				</div>
			))}
			{attachments.map((attachment) => (
				<div
					key={attachment.id}
					className="flex max-w-full shrink-0 items-center gap-2 rounded-lg bg-neutral-100 px-2 py-1 text-xs"
				>
					<FileText className="h-4 w-4 shrink-0 text-neutral-500" />
					<span className="max-w-48 truncate font-medium">{attachment.file.name}</span>
					<span className="text-xs text-neutral-500">
						{formatAttachmentSize(attachment.file.size)}
					</span>
					<button
						type="button"
						onClick={() =>
							setAttachments((current) =>
								current.filter((item) => item.id !== attachment.id),
							)
						}
						className="rounded-full p-1 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700"
					>
						<X className="h-3.5 w-3.5" />
						<span className="sr-only">{t("compose.removeAttachment")}</span>
					</button>
				</div>
			))}
		</div>
		<p className="px-3 pb-2 text-xs text-amber-700">{[...attachments.map((item) => item.file.size), ...storedAttachments.map((item) => item.size)].some((size) => size > attachmentPolicy.cloudThresholdBytes) ? t("compose.cloudWarning.will") : t("compose.cloudWarning.may")}</p>
		</div>
	);

	// Below md the popup is a bottom sheet: full width, anchored to the visual viewport (so the keyboard never covers the toolbar) and padded by the bottom safe area.
	const sheetClass = "compose-sheet max-md:inset-x-0 max-md:bottom-[var(--sheet-bottom,0px)] max-md:left-0 max-md:right-0 max-md:top-auto max-md:z-50 max-md:h-[var(--sheet-height,100dvh)] max-md:w-full max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[var(--sheet-pad,max(env(safe-area-inset-bottom),1rem))]";
	const frameClass =
		mode === "popup"
			? minimized
				? cn("fixed bottom-0 right-8 z-40 flex h-9 w-[min(260px,calc(100vw-32px))] flex-col overflow-hidden rounded-t-lg border border-neutral-200 bg-white shadow-2xl", sheetClass)
				: modalMode
				? cn("fixed left-1/2 top-1/2 z-50 flex h-[86vh] w-[min(860px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-white shadow-2xl", sheetClass)
				: cn("fixed bottom-0 right-8 z-40 flex h-[min(520px,calc(100vh-88px))] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-t-lg border border-neutral-200 bg-white shadow-2xl", sheetClass)
			: "relative flex h-full min-h-[720px] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm";

	return (
		<>
			{agentReview && <SendReview approvalId={agentReview.approvalId} snapshot={agentReview.snapshot} onClose={() => { reviewInProgressRef.current = false; setAgentReview(null); }} onSent={() => { reviewInProgressRef.current = false; setAgentReview(null); if (onClose) dismiss(); else router.push("/sent"); }} />}
			{mode === "popup" && modalMode && !minimized && <div className="fixed inset-0 z-40 bg-neutral-950/65" aria-hidden="true" />}
			{toast && (
				<div
					role={toast.type === "error" ? "alert" : "status"}
					className={cn(
						"fixed right-6 top-6 z-[60] rounded-lg px-4 py-3 text-sm font-medium shadow-lg",
						toast.type === "success" ? "bg-green-600 text-white" : "bg-red-600 text-white",
					)}
				>
					{toast.message}
				</div>
			)}
			<form onSubmit={onSubmit} className={cn(frameClass, closing && "compose-sheet-closing")} style={dragY ? { transform: `translateY(${dragY}px)`, transition: "none" } : undefined} ref={formRef} role={modalMode && !minimized ? "dialog" : mode === "popup" ? "region" : undefined} aria-modal={modalMode && !minimized || undefined} aria-label={mode === "popup" ? t("compose.dialogLabel") : undefined} onKeyDown={(event) => { if (modalMode && !minimized && event.key === "Escape") { event.preventDefault(); setModalMode(false); } }} onDragEnterCapture={minimized ? undefined : onFileDragEnter} onDragOverCapture={minimized ? undefined : onFileDragOver} onDragLeaveCapture={minimized ? undefined : onFileDragLeave} onDropCapture={minimized ? undefined : onFileDrop}>
				{draggingFiles && !minimized && (
					<div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-blue-400 bg-blue-50/90 text-sm font-medium text-blue-700" aria-hidden="true">
						{t("compose.dropFiles")}
					</div>
				)}
				<div {...sheetDrag} className="flex h-9 shrink-0 items-center justify-between max-md:h-12 max-md:touch-none bg-neutral-800 text-white dark:bg-neutral-100 px-4 text-sm font-medium">
					<span className="flex min-w-0 items-center gap-2 truncate  dark:text-neutral-900">
						{threading?.inReplyTo && <Reply className="h-3.5 w-3.5 text-neutral-300" />}
						{!threading?.inReplyTo && /^fwd?:/i.test(subject) && <Forward className="h-3.5 w-3.5 text-neutral-300" />}
						{loadingDraft
							? t("compose.title.loading")
							: threading?.inReplyTo
								? t("compose.title.reply")
								: /^fwd?:/i.test(subject)
									? t("compose.title.forward")
									: draftId
										? t("compose.title.saved")
										: t("compose.title.new")}
					</span>
					{mode === "popup" && (
						<div className="flex shrink-0 items-center gap-3 text-neutral-300">
							<button type="button" onClick={() => { setMinimized((current) => !current); setDraggingFiles(false); }} aria-label={minimized ? t("compose.restore") : t("compose.minimize")} title={minimized ? t("compose.restore") : t("compose.minimize")} className="max-md:hidden rounded p-1 hover:bg-neutral-700 dark:hover:bg-neutral-200 hover:text-white">
								{minimized ? <ChevronUp className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
							</button>
							<button type="button" onClick={() => { if (minimized) setMinimized(false); setModalMode((current) => !current); }} aria-label={modalMode ? t("compose.restoreFloating") : t("compose.openModal")} title={modalMode ? t("compose.restoreFloating") : t("compose.openModal")} className="max-md:hidden rounded p-1 dark:hover:bg-neutral-200 hover:bg-neutral-700 hover:text-white">
								{modalMode ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
							</button>
							<button type="button" onClick={dismiss} aria-label={t("compose.close")} className="rounded p-1 max-md:-m-2 max-md:p-3 hover:bg-neutral-700 dark:hover:bg-neutral-200 hover:text-white">
								<X className="h-4 w-4" />
							</button>
						</div>
					)}
				</div>
				<div className={cn("flex min-h-0 flex-1 flex-col", minimized && "hidden")}>
				<div className="border-b border-neutral-100 px-4 py-1 flex flex-row items-center">
					<Label htmlFor={`${mode}-from`} className="text-sm text-neutral-500">{t("compose.from")}</Label>
					<Select
						id={`${mode}-from`}
						value={selectedMailbox && selectedFrom ? `${selectedMailbox.id}|${selectedFrom}` : ""}
						onChange={(event) => selectSender(event.target.value)}
						// placeholder="Select a mailbox first"
						required
						disabled={loadingDraft || senderOptions.length === 0}
						className="h-8 px-0 py-1 text-sm shadow-none focus-visible:ring-0"
						containerClassName="border-0 flex-1"
					>
						{senderOptions.length === 0 && <option value="">{t("compose.selectMailboxFirst")}</option>}
						{senderOptions.map(({ mailbox, address }) => (
							<option key={`${mailbox.id}|${address}`} value={`${mailbox.id}|${address}`}>{address}</option>
						))}
					</Select>
				</div>
				<RecipientInput
					id={`${mode}-to`}
					label={t("compose.to")}
					value={to}
					onChange={setTo}
					placeholder={t("compose.toPlaceholder")}
					required
					autoFocus={!draftIdToLoad}
					disabled={loadingDraft}
					trailing={
						<>
							{!showCc && (
								<button type="button" className="rounded px-1 hover:text-neutral-800" onClick={() => setShowCc(true)}>
									{t("compose.cc")}
								</button>
							)}
							{!showBcc && (
								<button type="button" className="rounded px-1 hover:text-neutral-800" onClick={() => setShowBcc(true)}>
									{t("compose.bcc")}
								</button>
							)}
						</>
					}
				/>
				{showCc && (
					<RecipientInput
						id={`${mode}-cc`}
						label={t("compose.cc")}
						value={cc}
						onChange={setCc}
						placeholder={t("compose.ccPlaceholder")}
						disabled={loadingDraft}
						autoFocus={!loadingDraft && cc.length === 0}
					/>
				)}
				{showBcc && (
					<RecipientInput
						id={`${mode}-bcc`}
						label={t("compose.bcc")}
						value={bcc}
						onChange={setBcc}
						placeholder={t("compose.bccPlaceholder")}
						disabled={loadingDraft}
						autoFocus={!loadingDraft && bcc.length === 0}
					/>
				)}
				<div className="border-b border-neutral-100 px-4 py-1">
					<Label htmlFor={`${mode}-subject`} className="sr-only">{t("compose.subject")}</Label>
					<Input
						id={`${mode}-subject`}
						value={subject}
						onChange={(event) => setSubject(event.target.value)}
						placeholder={t("compose.subject")}
						required
						disabled={loadingDraft}
						className="h-8 border-0 px-0 py-1 shadow-none focus-visible:ring-0"
					/>
				</div>
				<Label htmlFor={`${mode}-text`} className="sr-only">{t("compose.body")}</Label>
				<RichTextEditor
					id={`${mode}-text`}
					value={html}
					onChange={setHtml}
					quotedHtml={quotedHtml}
					disabled={loadingDraft}
					placeholder={t("compose.bodyPlaceholder")}
					footerContent={attachmentContent}
					toolbarStart={
						<div className="flex items-center max-md:contents">
							<Button type="button" variant="secondary" size="sm" onClick={dismiss} className="md:hidden max-md:h-10 max-md:px-3.5 max-md:text-[15px]">
								{t("common.cancel")}
							</Button>
							<div className="flex items-center max-md:order-last max-md:ml-auto">
								<Button
									type="submit"
									size="sm"
									disabled={loading || loadingDraft || !fromAddr}
									className="rounded-r-none px-4 max-md:h-10 max-md:px-5 max-md:text-[15px]"
								>
									{loading ? t("compose.preparing") : scheduledAt ? t("compose.schedule") : agentRevision !== null ? t("compose.reviewSend") : t("compose.send")}
								</Button>
								<ScheduleSendMenu
									disabled={loading || loadingDraft || !fromAddr}
									value={scheduledAt}
									onChange={setScheduledAt}
									mailboxId={selectedMailbox?.id}
									from={fromAddr}
									onApplyTemplate={({ title, html: templateHtml }) => {
										setSubject((current) => current.trim() ? current : title);
										setHtml((current) => (hasMeaningfulHtml(current) ? `${current}${templateHtml}` : templateHtml));
									}}
								/>
							</div>
						</div>
					}
					toolbarEnd={
						<>
							{/* <span className="mx-1 h-5 w-px bg-neutral-200" /> */}
							<Input
								ref={attachmentInput}
								type="file"
								multiple
								className="hidden"
								onChange={(event) => addAttachments(event.target.files)}
							/>
							<Tooltip label={t("compose.attachTooltip", { max: attachmentPolicy.maxMb })}>
								<button
									type="button"
									aria-label={t("compose.attachFiles")}
									onClick={() => attachmentInput.current?.click()}
									disabled={loading || loadingDraft}
									className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:pointer-events-none disabled:opacity-50 max-md:px-2"
								>
									<Paperclip className="h-4 w-4" />
								</button>
							</Tooltip>
							<Tooltip label={trackOpens ? t("compose.trackOpensOn") : t("compose.trackOpensOff")}>
								<button
									type="button"
									aria-label={t("compose.trackOpens")}
									aria-pressed={trackOpens}
									onClick={() => setTrackOpens(!trackOpens)}
									disabled={loading || loadingDraft}
									className={cn(
										"rounded-md p-1.5 hover:bg-neutral-100 disabled:pointer-events-none disabled:opacity-50 max-md:px-2",
										trackOpens ? "text-blue-600 hover:text-blue-700" : "text-neutral-500 hover:text-neutral-900",
									)}
								>
									{trackOpens ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
								</button>
							</Tooltip>
							<Tooltip label={followUpDays ? t("followUp.remindOn", { when: t(followUpOptionKey(followUpDays)) }) : t("followUp.remindMe")}>
								<FollowUpMenu
									disabled={loading || loadingDraft}
									onPick={setFollowUpDays}
									onClear={followUpDays ? () => setFollowUpDays(null) : undefined}
									trigger={
										<button
											type="button"
											aria-label={t("followUp.remindMe")}
											className={cn(
												"rounded-md p-1.5 hover:bg-neutral-100 disabled:pointer-events-none disabled:opacity-50 max-md:px-2",
												followUpDays ? "text-amber-600 hover:text-amber-700" : "text-neutral-500 hover:text-neutral-900",
											)}
										>
											<BellRing className="h-4 w-4" />
										</button>
									}
								/>
							</Tooltip>
							<span className="flex-1 max-md:hidden" />
							<Tooltip label={t("compose.deleteDraft")}>
								<button
									type="button"
									aria-label={t("compose.deleteDraft")}
									onClick={() => void deleteDraftAndClose()}
									disabled={loading || loadingDraft || deletingDraft}
									className="rounded-md p-1.5 text-neutral-500 hover:bg-red-50 hover:text-red-600 disabled:pointer-events-none disabled:opacity-50 max-md:px-2"
								>
									<Trash2 className="h-4 w-4" />
								</button>
							</Tooltip>
						</>
					}
				/>
				</div>
			</form>
		</>
	);
}
