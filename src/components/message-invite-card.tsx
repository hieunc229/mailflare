"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import toast from "react-hot-toast";
import { CalendarDays, Check, X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { authFetch } from "@/lib/auth/client";
import { cacheAnsweredInvite, fetchInviteCard, getCachedInviteCard } from "@/lib/calendar/invite-cache";
import type { InviteResponse, InviteView } from "@/lib/calendar/invite-types";
import { formatUserDate } from "@/lib/time/utils";

export function MessageInviteCard({ messageId, hasCalendarAttachment, className }: { messageId: string; hasCalendarAttachment: boolean; className?: string }) {
	const { t } = useLanguage();
	const [initial] = useState(() => getCachedInviteCard(messageId));
	const [invite, setInvite] = useState<InviteView | null>(initial?.invite ?? null);
	const [eventId, setEventId] = useState<string | null>(initial?.eventId ?? null);
	const [answered, setAnswered] = useState<InviteResponse | null>(initial?.response ?? null);
	const [loading, setLoading] = useState(initial === undefined);
	const [pending, setPending] = useState<InviteResponse | null>(null);
	// Whether the answer emails the organizer; remembered per browser, default on.
	const [notify, setNotify] = useState(() => {
		try {
			if (typeof window === "undefined") return true;
			const stored = window.localStorage.getItem("invite-notify-default");
			return stored === null ? true : stored !== "false";
		} catch { return true; }
	});
	const [noteOpen, setNoteOpen] = useState(false);
	const [note, setNote] = useState("");

	function setNotifyAndPersist(value: boolean) {
		setNotify(value);
		try { window.localStorage.setItem("invite-notify-default", String(value)); } catch { /* private mode */ }
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
				setLoading(false);
			})
			.catch(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, [messageId, hasCalendarAttachment, initial]);

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
		: `${formatUserDate(start, { dateStyle: "full", timeStyle: "short" })} - ${formatUserDate(end, { timeStyle: "short" })}`;

	async function respond(response: InviteResponse) {
		setPending(response);
		try {
			const result = await authFetch(`/api/messages/${messageId}/invite`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response, sendReply: notify, note }) });
			const data = await result.json().catch(() => ({})) as { error?: string; eventId?: string | null; replySent?: boolean };
			if (!result.ok) throw new Error(data.error ?? t("invite.failed"));
			const nextEventId = data.eventId ?? null;
			setAnswered(response);
			setEventId(nextEventId);
			setNote("");
			setNoteOpen(false);
			cacheAnsweredInvite(messageId, {
				invite: currentInvite,
				eventId: nextEventId,
				response,
				canRespond: currentInvite.method === "REQUEST" || currentInvite.method === "PUBLISH",
			});
			toast.success(response === "declined" ? t("invite.declined") : t("invite.added"));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("invite.failed"));
		} finally {
			setPending(null);
		}
	}

	return (
		<section className={clsx("rounded-xl bg-[#f0f4f8] p-4", className)}>
			<div className="flex items-start gap-3">
				<CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
				<div className="min-w-0 flex-1">
					<p className="text-[11px] font-medium uppercase text-neutral-500">{cancelled ? t("invite.cancelled") : t("invite.heading")}</p>
					<h2 className="mt-0.5 break-words text-sm font-semibold text-neutral-900">{currentInvite.title}</h2>
					<p className="mt-1 text-xs text-neutral-700">{when}</p>
					{currentInvite.recurrenceId && (
						<p className="mt-1 text-xs text-neutral-600">{t("invite.singleInstance", { date: formatUserDate(new Date(currentInvite.recurrenceId), { dateStyle: "full" }) })}</p>
					)}
					{currentInvite.location && <p className="mt-0.5 break-words text-xs text-neutral-600">{currentInvite.location}</p>}
					{currentInvite.organizer && <p className="mt-0.5 text-xs text-neutral-600">{t("invite.organizer", { organizer: currentInvite.organizer })}</p>}
					{currentInvite.attendees && currentInvite.attendees.length > 0 && (
						<p className="mt-0.5 break-words text-xs text-neutral-600">
							{currentInvite.attendees.slice(0, 5).map((attendee) => { const status = attendee.status || "NEEDS-ACTION"; return `${attendee.email} (${status.charAt(0)}${status.slice(1).toLowerCase()})`; }).join(", ")}
							{currentInvite.attendees.length > 5 ? ` +${currentInvite.attendees.length - 5} more` : ""}
						</p>
					)}
					<div className="mt-3 flex flex-wrap items-center gap-2">
						{cancelled ? (
							<Button size="sm" disabled={pending !== null || !eventId} onClick={() => void respond("declined")} variant="outline" className="rounded-full border-0 bg-white text-neutral-700 hover:bg-neutral-50">{t("invite.removeFromCalendar")}</Button>
						) : (
							<>
								{(["accepted", "tentative", "declined"] as const).map((option) => {
									const selected = answered === option;
									const primary = answered === null && option === "accepted";
									const label = {
										accepted: selected ? t("invite.acceptedLabel") : t("invite.accept"),
										tentative: t("invite.maybe"),
										declined: selected ? t("invite.declinedLabel") : t("invite.decline"),
									}[option];
									const selectedColor = { accepted: "text-green-600", tentative: "text-orange-400", declined: "text-red-600" }[option];
									return <Button key={option} size="sm" disabled={pending !== null} onClick={() => void respond(option)} variant={primary ? "default" : "outline"} aria-pressed={selected} className={clsx("rounded-full", !primary && "border-0 bg-white hover:bg-neutral-50", selected ? clsx("font-semibold", selectedColor) : primary ? "text-white" : "text-neutral-700", answered !== null && !selected && "opacity-50")}>{selected && option === "accepted" && <Check className="h-4 w-4" />}{selected && option === "declined" && <X className="h-4 w-4" />}{label}</Button>;
								})}
							</>
						)}
						{eventId && answered !== "declined" && <a href={`/calendar?event=${eventId}`} className="ml-auto text-xs font-medium text-blue-700 hover:underline">{t("invite.viewOnCalendar")}</a>}
					</div>
					{!cancelled && (
						<div className="mt-2 space-y-2">
							<label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-700">
								<input type="checkbox" checked={notify} disabled={pending !== null} onChange={(event) => setNotifyAndPersist(event.target.checked)} className="h-3.5 w-3.5 rounded accent-blue-600" />
								{t("invite.notifyByEmail")}
							</label>
							<p className="text-[11px] text-neutral-500">{t("invite.notifyHint")}</p>
							<div>
								<button type="button" onClick={() => setNoteOpen((open) => !open)} aria-expanded={noteOpen} className="text-xs font-medium text-blue-700 hover:underline">{t("invite.addNote")}</button>
								{noteOpen && (
									<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={2} placeholder={t("invite.notePlaceholder")} className="mt-1 w-full rounded-lg border border-neutral-200 bg-white p-2 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-blue-500 focus:outline-none" />
								)}
							</div>
						</div>
					)}
				</div>
			</div>
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
