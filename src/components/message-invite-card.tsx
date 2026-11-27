"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import toast from "react-hot-toast";
import { CalendarDays, Check, ChevronDown, Clock, MoreVerticalCircle01, UserMultiple02, X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { MessageActionMenu, MessageActionMenuItem } from "@/components/message-actions/action-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { authFetch } from "@/lib/auth/client";
import { cacheAnsweredInvite, fetchInviteCard, getCachedInviteCard } from "@/lib/calendar/invite-cache";
import type { InviteResponse, InviteView } from "@/lib/calendar/invite-types";
import { formatUserDate } from "@/lib/time/utils";

/** How long an answer waits for Undo before it is actually sent. */
const SEND_DELAY_MS = 8000;
const NOTIFY_KEY = "invite-notify-default";

type Snapshot = { answered: InviteResponse | null; eventId: string | null };

type SendIntent = {
	response: InviteResponse;
	sendReply: boolean;
	note: string;
	counter: { startsAt: string; endsAt: string } | null;
};

function readNotifyDefault(): boolean {
	try {
		if (typeof window === "undefined") return true;
		const stored = window.localStorage.getItem(NOTIFY_KEY);
		return stored === null ? true : stored !== "false";
	} catch { return true; }
}

const pad2 = (value: number) => String(value).padStart(2, "0");
const toDateInput = (value: Date) => `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
const toTimeInput = (value: Date) => `${pad2(value.getHours())}:${pad2(value.getMinutes())}`;

export function MessageInviteCard({ messageId, hasCalendarAttachment, className }: { messageId: string; hasCalendarAttachment: boolean; className?: string }) {
	const { t } = useLanguage();
	const [initial] = useState(() => getCachedInviteCard(messageId));
	const [invite, setInvite] = useState<InviteView | null>(initial?.invite ?? null);
	const [eventId, setEventId] = useState<string | null>(initial?.eventId ?? null);
	const [answered, setAnswered] = useState<InviteResponse | null>(initial?.response ?? null);
	const [loading, setLoading] = useState(initial === undefined);
	const [inFlight, setInFlight] = useState<InviteResponse | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [noteOpen, setNoteOpen] = useState(false);
	const [dialogChoice, setDialogChoice] = useState<InviteResponse>("accepted");
	const [dialogNotify, setDialogNotify] = useState(readNotifyDefault);
	const [dialogNote, setDialogNote] = useState("");
	const [proposeOpen, setProposeOpen] = useState(false);
	const [proposalRsvp, setProposalRsvp] = useState<InviteResponse>("tentative");
	const [proposalStartDate, setProposalStartDate] = useState("");
	const [proposalStartTime, setProposalStartTime] = useState("");
	const [proposalEndDate, setProposalEndDate] = useState("");
	const [proposalEndTime, setProposalEndTime] = useState("");
	const [proposalMessage, setProposalMessage] = useState("");
	const [proposalError, setProposalError] = useState<string | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const overflowBtnRef = useRef<HTMLButtonElement | null>(null);
	const firstMenuItemRef = useRef<HTMLButtonElement | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingRef = useRef<(SendIntent & { prev: Snapshot; toastId: string }) | null>(null);
	// Guard so the timer, unmount flush, pagehide flush and storage resume can never send the same intent twice.
	const sentRef = useRef(false);
	const didResumeRef = useRef(false);
	const confirmedRef = useRef<Snapshot>({ answered: initial?.response ?? null, eventId: initial?.eventId ?? null });
	const storageKey = `invite-pending:${messageId}`;

	function buildIntentBody(intent: SendIntent) {
		return intent.counter
			? { action: "counter", startsAt: intent.counter.startsAt, endsAt: intent.counter.endsAt, rsvp: intent.response, note: intent.note, sendReply: intent.sendReply }
			: { response: intent.response, sendReply: intent.sendReply, note: intent.note };
	}

	function clearStoredIntent() {
		try { if (typeof window !== "undefined") window.sessionStorage.removeItem(storageKey); } catch { /* private mode */ }
	}

	function writeStoredIntent(intent: SendIntent) {
		try {
			if (typeof window !== "undefined") window.sessionStorage.setItem(storageKey, JSON.stringify({ ...intent, scheduledAt: Date.now() }));
		} catch { /* private mode */ }
	}

	function actionLabel(response: InviteResponse): string {
		return response === "accepted" ? t("invite.acceptedLabel") : response === "declined" ? t("invite.declinedLabel") : t("invite.maybe");
	}

	function undoSend() {
		const pending = pendingRef.current;
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = null;
		pendingRef.current = null;
		clearStoredIntent();
		if (!pending) return;
		toast.dismiss(pending.toastId);
		setAnswered(pending.prev.answered);
		setEventId(pending.prev.eventId);
	}

	async function fireSend() {
		const pending = pendingRef.current;
		pendingRef.current = null;
		timerRef.current = null;
		if (!pending) return;
		if (sentRef.current) return;
		sentRef.current = true;
		clearStoredIntent();
		setInFlight(pending.response);
		try {
			const body = buildIntentBody(pending);
			const result = await authFetch(`/api/messages/${messageId}/invite`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			const data = await result.json().catch(() => ({})) as { error?: string; eventId?: string | null };
			if (!result.ok) throw new Error(data.error ?? (pending.counter ? t("invite.counterFailed") : t("invite.failed")));
			const nextEventId = data.eventId ?? null;
			setEventId(nextEventId);
			const currentInvite = invite;
			if (currentInvite) {
				cacheAnsweredInvite(messageId, {
					invite: currentInvite,
					eventId: nextEventId,
					response: pending.response,
					canRespond: currentInvite.method === "REQUEST" || currentInvite.method === "PUBLISH",
					answeredAt: new Date().toISOString(),
				});
			}
			confirmedRef.current = { answered: pending.response, eventId: nextEventId };
			toast.dismiss(pending.toastId);
			if (pending.counter) toast.success(t("invite.proposalSent"));
			else toast.success(pending.response === "declined" ? t("invite.declined") : t("invite.added"));
		} catch (error) {
			toast.dismiss(pending.toastId);
			const confirmed = confirmedRef.current;
			setAnswered(confirmed.answered);
			setEventId(confirmed.eventId);
			toast.error(error instanceof Error ? error.message : (pending.counter ? t("invite.counterFailed") : t("invite.failed")));
		} finally {
			setInFlight(null);
		}
	}

	const fireRef = useRef(() => {});
	fireRef.current = () => { void fireSend(); };

	// A pending answer must never be dropped: send it when the card goes away.
	useEffect(() => () => {
		if (pendingRef.current) {
			if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
			void fireRef.current();
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// A pending answer must survive a reload/close during the undo window: it is mirrored to
	// sessionStorage on schedule, resumed on mount, and flushed with keepalive on pagehide.
	useEffect(() => {
		if (!didResumeRef.current) {
			didResumeRef.current = true;
			try {
				const raw = window.sessionStorage.getItem(storageKey);
				if (raw && !pendingRef.current && !sentRef.current) {
					const stored = JSON.parse(raw) as Partial<SendIntent> & { scheduledAt?: unknown };
					const age = typeof stored.scheduledAt === "number" ? Date.now() - stored.scheduledAt : Number.POSITIVE_INFINITY;
					if (age < 60_000 && (stored.response === "accepted" || stored.response === "tentative" || stored.response === "declined")) {
						const intent: SendIntent = {
							response: stored.response,
							sendReply: !!stored.sendReply,
							note: typeof stored.note === "string" ? stored.note : "",
							counter: stored.counter && typeof stored.counter.startsAt === "string" && typeof stored.counter.endsAt === "string" ? { startsAt: stored.counter.startsAt, endsAt: stored.counter.endsAt } : null,
						};
						sentRef.current = true;
						try { window.sessionStorage.removeItem(storageKey); } catch { /* private mode */ }
						const prev: Snapshot = { ...confirmedRef.current };
						setAnswered(intent.response);
						if (!intent.counter && intent.response === "declined") setEventId(null);
						pendingRef.current = { ...intent, prev, toastId: "" };
						void fireRef.current();
					} else if (age >= 60_000) {
						try { window.sessionStorage.removeItem(storageKey); } catch { /* private mode */ }
					}
				}
			} catch { /* corrupt storage */ }
		}
		const onPageHide = () => {
			const pending = pendingRef.current;
			if (!pending || sentRef.current) return;
			sentRef.current = true;
			pendingRef.current = null;
			if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
			try {
				const headers: Record<string, string> = { "Content-Type": "application/json" };
				try {
					const token = window.localStorage.getItem("mailflare-session-token");
					if (token) headers["Authorization"] = `Bearer ${token}`;
					headers["X-Time-Zone"] = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
				} catch { /* private mode */ }
				void fetch(`/api/messages/${messageId}/invite`, {
					method: "POST",
					headers,
					body: JSON.stringify(buildIntentBody(pending)),
					keepalive: true,
					credentials: "include",
				});
			} catch { /* best-effort */ }
			try { window.sessionStorage.removeItem(storageKey); } catch { /* private mode */ }
		};
		window.addEventListener("pagehide", onPageHide);
		return () => window.removeEventListener("pagehide", onPageHide);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [messageId]);

	function scheduleSend(intent: SendIntent) {
		const prev: Snapshot = { answered, eventId };
		sentRef.current = false;
		if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
		if (pendingRef.current) toast.dismiss(pendingRef.current.toastId);
		setAnswered(intent.response);
		// A decline removes the event, so the calendar link hides at once; anything else keeps it.
		if (!intent.counter && intent.response === "declined") setEventId(null);
		const actionWord = intent.counter ? t("invite.proposalSent") : actionLabel(intent.response);
		const toastId = toast(() => (
			<span className="flex items-center gap-2">
				<span>{actionWord} —</span>
				<button type="button" onClick={undoSend} className="font-semibold text-blue-700 hover:underline">{t("invite.undo")}</button>
			</span>
		), { duration: SEND_DELAY_MS });
		pendingRef.current = { ...intent, prev, toastId };
		writeStoredIntent(intent);
		timerRef.current = setTimeout(() => { void fireSend(); }, SEND_DELAY_MS);
	}

	function setDialogNotifyAndPersist(value: boolean) {
		setDialogNotify(value);
		try { window.localStorage.setItem(NOTIFY_KEY, String(value)); } catch { /* private mode */ }
	}

	function openNoteDialog() {
		setMenuOpen(false);
		setDialogChoice(answered ?? "accepted");
		setDialogNotify(true);
		setDialogNote("");
		setNoteOpen(true);
	}

	function openProposeDialog() {
		setMenuOpen(false);
		if (!invite) return;
		const start = new Date(invite.startsAt);
		const end = new Date(invite.endsAt);
		setProposalRsvp("tentative");
		setProposalStartDate(toDateInput(start));
		setProposalStartTime(toTimeInput(start));
		setProposalEndDate(toDateInput(end));
		setProposalEndTime(toTimeInput(end));
		setProposalMessage("");
		setProposalError(null);
		setProposeOpen(true);
	}

	function sendFromNoteDialog() {
		setNoteOpen(false);
		scheduleSend({ response: dialogChoice, sendReply: dialogNotify, note: dialogNote, counter: null });
	}

	function sendProposal() {
		const start = new Date(`${proposalStartDate}T${proposalStartTime}`);
		const end = new Date(`${proposalEndDate}T${proposalEndTime}`);
		if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
			setProposalError(t("invite.timeError"));
			return;
		}
		setProposeOpen(false);
		scheduleSend({ response: proposalRsvp, sendReply: true, note: proposalMessage, counter: { startsAt: start.toISOString(), endsAt: end.toISOString() } });
	}

	// The caller keys this card by message, so state starts fresh for each message without resetting it here.
	useEffect(() => {
		if (!hasCalendarAttachment || initial !== undefined) return;
		let active = true;
		void fetchInviteCard(messageId)
			.then((data) => {
				if (!active) return;
				setInvite(data?.invite ?? null);
				setEventId(data?.eventId ?? null);
				setAnswered(data?.response ?? null);
					confirmedRef.current = { answered: data?.response ?? null, eventId: data?.eventId ?? null };
				setLoading(false);
			})
			.catch(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, [messageId, hasCalendarAttachment, initial]);

	useEffect(() => {
		if (!menuOpen) return;
		firstMenuItemRef.current?.focus();
		const onPointerDown = (event: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setMenuOpen(false);
				overflowBtnRef.current?.focus();
			}
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [menuOpen]);

	if (!hasCalendarAttachment) return null;
	if (!invite) return loading ? <InviteCardSkeleton className={className} /> : null;
	const currentInvite = invite;
	const cancelled = currentInvite.method === "CANCEL";
	if (currentInvite.method === "REPLY") {
		const answer = currentInvite.attendees?.[0];
		const key = { ACCEPTED: "invite.reply.accepted", TENTATIVE: "invite.reply.tentative", DECLINED: "invite.reply.declined" }[answer?.status ?? ""];
		return (
			<section className={clsx("rounded-xl bg-[#f0f4f8] p-4", className)}>
				<div className="flex items-start gap-3">
					<CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
					<div className="min-w-0 flex-1">
						<p className="text-[11px] font-medium uppercase text-neutral-500">{t("invite.reply.heading")}</p>
						<h2 className="mt-0.5 break-words text-sm font-semibold text-neutral-900">{currentInvite.title}</h2>
						{answer && key && <p className="mt-1 text-xs text-neutral-700">{t(key as Parameters<typeof t>[0], { guest: answer.email })}</p>}
					</div>
				</div>
			</section>
		);
	}
	const start = new Date(currentInvite.startsAt);
	const end = new Date(currentInvite.endsAt);
	// All-day dates arrive as local midnights in the user's zone with an exclusive end, so the last day is the one before it.
	const lastDay = new Date(end.getTime() - 1);
	const when = currentInvite.allDay
		? formatUserDate(start, { dateStyle: "full" }) === formatUserDate(lastDay, { dateStyle: "full" })
			? formatUserDate(start, { dateStyle: "full" })
			: `${formatUserDate(start, { dateStyle: "full" })} - ${formatUserDate(lastDay, { dateStyle: "full" })}`
		// An end on another day carries its date, so the range is not misread.
		: `${formatUserDate(start, { dateStyle: "full" })} • ${formatUserDate(start, { timeStyle: "short" })} – ${formatUserDate(end, formatUserDate(start, { dateStyle: "full" }) === formatUserDate(end, { dateStyle: "full" }) ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" })}`;

	const choiceKey = { accepted: "invite.choice.accepted", tentative: "invite.choice.tentative", declined: "invite.choice.declined" }[dialogChoice] as Parameters<typeof t>[0];
	const sendLabel = dialogNotify ? t("invite.sendChoice", { choice: t(choiceKey) }) : t("invite.saveQuietly");
	const organizer = currentInvite.organizer?.toLowerCase() ?? null;
	const statusLabel = (status: string) => status === "ACCEPTED" ? t("invite.acceptedLabel") : status === "DECLINED" ? t("invite.declinedLabel") : status === "TENTATIVE" ? t("invite.maybe") : t("invite.needsConfirmation");
	const people = [
		...(currentInvite.organizer ? [{ email: currentInvite.organizer, role: t("invite.organizerRole") }] : []),
		...(currentInvite.attendees ?? []).filter((attendee) => attendee.email.toLowerCase() !== organizer).map((attendee) => ({ email: attendee.email, role: statusLabel(attendee.status) })),
	];
	const responses = [
		{ value: "accepted", label: t("invite.accept"), selectedLabel: t("invite.acceptedLabel"), icon: <Check className="h-4 w-4" /> },
		{ value: "tentative", label: t("invite.maybe"), selectedLabel: t("invite.maybe"), icon: <Clock className="h-4 w-4" /> },
		{ value: "declined", label: t("invite.decline"), selectedLabel: t("invite.declinedLabel"), icon: <X className="h-4 w-4" /> },
	] as const;
	const selectedResponse = responses.find((option) => option.value === answered);
	const respond = (response: InviteResponse) => scheduleSend({ response, sendReply: readNotifyDefault(), note: "", counter: null });

	return (
		<section className={clsx("relative rounded-xl bg-[#f0f4f8] p-4", className)}>
			{!cancelled && (
				<div className="absolute right-2 top-2" ref={menuRef}>
					<Button ref={overflowBtnRef} type="button" variant="round" size="round" aria-label={t("invite.moreOptions")} title={t("invite.moreOptions")} aria-haspopup="menu" aria-expanded={menuOpen} disabled={inFlight !== null} onClick={() => setMenuOpen((open) => !open)} className="text-neutral-600 before:hidden">
						<MoreVerticalCircle01 size={16} aria-hidden="true" />
					</Button>
					{menuOpen && (
						<div role="menu" className="absolute right-0 top-full z-10 mt-1 min-w-44 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg">
							<button ref={firstMenuItemRef} type="button" role="menuitem" onClick={openNoteDialog} className="flex w-full items-center px-4 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none">{t("invite.respondWithNote")}</button>
							<button type="button" role="menuitem" onClick={openProposeDialog} className="flex w-full items-center px-4 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none">{t("invite.proposeNewTime")}</button>
						</div>
					)}
				</div>
			)}
			<div>
				<div className="min-w-0">
					{cancelled && <p className="text-[11px] font-medium uppercase text-neutral-500">{t("invite.cancelled")}</p>}
					<p className="pr-10 text-xs font-semibold text-neutral-900">{when}</p>
					<h2 className="mt-0.5 break-words pr-10 text-xl text-neutral-900">{currentInvite.title}</h2>
					{currentInvite.recurrenceId && (
						<p className="mt-1 text-xs text-neutral-600">{t("invite.singleInstance", { date: formatUserDate(new Date(currentInvite.recurrenceId), { dateStyle: "full" }) })}</p>
					)}
					{currentInvite.location && <p className="mt-0.5 break-words text-xs text-neutral-600">{currentInvite.location}</p>}
					{people.length > 0 && (
						<div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-3 text-sm">
							<UserMultiple02 size={15} aria-hidden="true" className="mt-0.5" />
							<ul className="space-y-1">
								{people.slice(0, 5).map((person) => (
									<li key={person.email} className="break-words text-neutral-900">
										{person.email} <span className="text-neutral-500 lowercase">({person.role})</span>
									</li>
								))}
								{people.length > 5 && <li className="text-neutral-500">{t("invite.moreGuests", { count: people.length - 5 })}</li>}
							</ul>
						</div>
					)}
					<div className="mt-3 flex flex-wrap items-center gap-2">
						{cancelled ? (
							<Button size="sm" disabled={inFlight !== null || !eventId} onClick={() => scheduleSend({ response: "declined", sendReply: readNotifyDefault(), note: "", counter: null })} variant="outline" className="rounded-full border-0 bg-white text-neutral-700 hover:bg-neutral-50">{t("invite.removeFromCalendar")}</Button>
						) : (
							<>
								{selectedResponse ? (
									<MessageActionMenu
										label={t("invite.changeResponse")}
										className="w-40"
										trigger={
											<Button size="sm" disabled={inFlight !== null} className="rounded-full text-white">
												{selectedResponse.selectedLabel}
												<ChevronDown className="h-4 w-4" aria-hidden="true" />
											</Button>
										}
									>
										{responses.map((option) => {
											const selected = option.value === answered;
											return (
												<MessageActionMenuItem key={option.value} icon={option.icon} onSelect={() => { if (!selected) respond(option.value); }}>
													<span aria-current={selected || undefined} className={clsx(selected && "font-semibold text-blue-700")}>{selected ? option.selectedLabel : option.label}</span>
												</MessageActionMenuItem>
											);
										})}
									</MessageActionMenu>
								) : responses.map((option) => {
									const primary = option.value === "accepted";
									return <Button key={option.value} size="sm" disabled={inFlight !== null} onClick={() => respond(option.value)} variant={primary ? "default" : "outline"} className={clsx("rounded-full", primary ? "text-white" : "border-0 bg-white text-neutral-700 hover:bg-neutral-50")}>{option.label}</Button>;
								})}
							</>
						)}
						{eventId && answered !== "declined" && <a href={`/calendar?event=${eventId}`} className="ml-auto text-xs font-medium text-blue-700 hover:underline">{t("invite.viewOnCalendar")}</a>}
					</div>
				</div>
			</div>
			<Dialog open={noteOpen} onOpenChange={setNoteOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("invite.respondWithNote")}</DialogTitle>
						<DialogDescription>{currentInvite.title}</DialogDescription>
					</DialogHeader>
					<div role="group" aria-label={t("invite.rsvp")} className="flex overflow-hidden rounded-lg border border-neutral-200">
						{(["accepted", "tentative", "declined"] as const).map((option) => {
							const selected = dialogChoice === option;
							const label = option === "accepted" ? t("invite.choice.yes") : option === "declined" ? t("invite.choice.no") : t("invite.maybe");
							return (
								<button key={option} type="button" aria-pressed={selected} onClick={() => setDialogChoice(option)} className={clsx("flex-1 px-3 py-2 text-sm", selected ? "bg-blue-600 font-semibold text-white" : "bg-white text-neutral-700 hover:bg-neutral-50")}>{label}</button>
							);
						})}
					</div>
					<div className="mt-2 space-y-2">
						<label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-700">
							<input type="checkbox" checked={dialogNotify} onChange={(event) => setDialogNotifyAndPersist(event.target.checked)} className="h-3.5 w-3.5 rounded accent-blue-600" />
							{t("invite.notifyByEmail")}
						</label>
						<p className="text-[11px] text-neutral-500">{t("invite.notifyHint")}</p>
					</div>
					<textarea value={dialogNote} onChange={(event) => setDialogNote(event.target.value)} maxLength={500} rows={2} placeholder={t("invite.notePlaceholder")} className="w-full rounded-lg border border-neutral-200 bg-white p-2 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-blue-500 focus:outline-none" />
					<div className="flex justify-end gap-2">
						<Button variant="outline" onClick={() => setNoteOpen(false)}>{t("common.cancel")}</Button>
						<Button onClick={sendFromNoteDialog}>{sendLabel}</Button>
					</div>
				</DialogContent>
			</Dialog>
			<Dialog open={proposeOpen} onOpenChange={setProposeOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("invite.proposeNewTime")}</DialogTitle>
						<DialogDescription>{currentInvite.title}</DialogDescription>
					</DialogHeader>
					<div className="space-y-1 text-sm text-neutral-700">
						<p><span className="font-medium">{t("invite.currentTime")}:</span> {when}</p>
						{currentInvite.recurrenceId && (
							<p className="text-xs text-neutral-600">{t("invite.singleInstance", { date: formatUserDate(new Date(currentInvite.recurrenceId), { dateStyle: "full" }) })}</p>
						)}
					</div>
					<label className="flex items-center gap-2 text-sm text-neutral-700">
						<span>{t("invite.rsvp")}:</span>
						<select value={proposalRsvp} onChange={(event) => setProposalRsvp(event.target.value as InviteResponse)} className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-900 focus:border-blue-500 focus:outline-none">
							<option value="accepted">{t("invite.accept")}</option>
							<option value="tentative">{t("invite.maybe")}</option>
							<option value="declined">{t("invite.decline")}</option>
						</select>
					</label>
					<div className="grid grid-cols-2 gap-2">
						<label className="space-y-1 text-xs text-neutral-700">
							<span>{t("invite.starts")}</span>
							<input type="date" value={proposalStartDate} onChange={(event) => setProposalStartDate(event.target.value)} className="w-full rounded-lg border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-900 focus:border-blue-500 focus:outline-none" />
							<input type="time" value={proposalStartTime} onChange={(event) => setProposalStartTime(event.target.value)} className="w-full rounded-lg border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-900 focus:border-blue-500 focus:outline-none" />
						</label>
						<label className="space-y-1 text-xs text-neutral-700">
							<span>{t("invite.ends")}</span>
							<input type="date" value={proposalEndDate} onChange={(event) => setProposalEndDate(event.target.value)} className="w-full rounded-lg border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-900 focus:border-blue-500 focus:outline-none" />
							<input type="time" value={proposalEndTime} onChange={(event) => setProposalEndTime(event.target.value)} className="w-full rounded-lg border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-900 focus:border-blue-500 focus:outline-none" />
						</label>
					</div>
					{proposalError && <p role="alert" className="text-xs text-red-600">{proposalError}</p>}
					<label className="space-y-1 text-xs text-neutral-700">
						<span>{t("invite.messageOptional")}</span>
						<textarea value={proposalMessage} onChange={(event) => setProposalMessage(event.target.value)} maxLength={500} rows={2} placeholder={t("invite.notePlaceholder")} className="w-full rounded-lg border border-neutral-200 bg-white p-2 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-blue-500 focus:outline-none" />
					</label>
					<div className="flex justify-end gap-2">
						<Button variant="outline" onClick={() => setProposeOpen(false)}>{t("common.cancel")}</Button>
						<Button onClick={sendProposal}>{t("invite.sendProposal")}</Button>
					</div>
				</DialogContent>
			</Dialog>
		</section>
	);
}

function InviteCardSkeleton({ className }: { className?: string }) {
	return (
		<section aria-busy="true" className={clsx("rounded-xl bg-[#f0f4f8] p-4", className)}>
			<div className="flex items-start gap-3">
				<Skeleton className="mt-0.5 h-5 w-5 shrink-0 rounded-md" />
				<div className="min-w-0 flex-1 space-y-2">
					<Skeleton className="h-3 w-24" />
					<Skeleton className="h-4 w-3/4" />
					<Skeleton className="h-3 w-1/2" />
					<div className="flex flex-wrap gap-2 pt-1">
						<Skeleton className="h-8 w-20 rounded-full" />
						<Skeleton className="h-8 w-20 rounded-full" />
						<Skeleton className="h-8 w-24 rounded-full" />
					</div>
				</div>
			</div>
		</section>
	);
}
