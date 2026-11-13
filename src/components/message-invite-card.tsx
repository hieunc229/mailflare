"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { CalendarDays } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";
import { formatUserDate } from "@/lib/time/utils";

type InviteView = {
	title: string;
	description: string;
	location: string;
	startsAt: string;
	endsAt: string;
	allDay: boolean;
	organizer: string | null;
	method: string;
	attendees?: { email: string; status: string }[];
};

type InviteResponse = "accepted" | "tentative" | "declined";

export function MessageInviteCard({ messageId, hasCalendarAttachment }: { messageId: string; hasCalendarAttachment: boolean }) {
	const { t } = useLanguage();
	const [invite, setInvite] = useState<InviteView | null>(null);
	const [eventId, setEventId] = useState<string | null>(null);
	const [answered, setAnswered] = useState<InviteResponse | null>(null);
	const [pending, setPending] = useState<InviteResponse | null>(null);

	useEffect(() => {
		setInvite(null);
		setEventId(null);
		setAnswered(null);
		if (!hasCalendarAttachment) return;
		let active = true;
		void authFetch(`/api/messages/${messageId}/invite`)
			.then(async (response) => (response.ok ? await response.json() as { invite: InviteView | null; eventId: string | null } : null))
			.then((data) => { if (active && data?.invite) { setInvite(data.invite); setEventId(data.eventId); } })
			.catch(() => undefined);
		return () => { active = false; };
	}, [messageId, hasCalendarAttachment]);

	if (!invite) return null;
	const cancelled = invite.method === "CANCEL";
	if (invite.method === "REPLY") {
		const answer = invite.attendees?.[0];
		const key = { ACCEPTED: "invite.reply.accepted", TENTATIVE: "invite.reply.tentative", DECLINED: "invite.reply.declined" }[answer?.status ?? ""];
		return (
			<section className="mt-6 rounded-xl border border-neutral-200 bg-neutral-50 p-4 sm:ml-16">
				<div className="flex items-start gap-3">
					<CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
					<div className="min-w-0 flex-1">
						<p className="text-xs font-medium uppercase text-neutral-500">{t("invite.reply.heading")}</p>
						<h2 className="mt-0.5 break-words text-base font-semibold text-neutral-900">{invite.title}</h2>
						{answer && key && <p className="mt-1 text-sm text-neutral-700">{t(key as Parameters<typeof t>[0], { guest: answer.email })}</p>}
					</div>
				</div>
			</section>
		);
	}
	const start = new Date(invite.startsAt);
	const end = new Date(invite.endsAt);
	// All-day dates arrive as local midnights in the user's zone with an exclusive end, so the last day is the one before it.
	const lastDay = new Date(end.getTime() - 1);
	const when = invite.allDay
		? formatUserDate(start, { dateStyle: "full" }) === formatUserDate(lastDay, { dateStyle: "full" })
			? formatUserDate(start, { dateStyle: "full" })
			: `${formatUserDate(start, { dateStyle: "full" })} - ${formatUserDate(lastDay, { dateStyle: "full" })}`
		: `${formatUserDate(start, { dateStyle: "full", timeStyle: "short" })} - ${formatUserDate(end, { timeStyle: "short" })}`;

	async function respond(response: InviteResponse) {
		setPending(response);
		try {
			const result = await authFetch(`/api/messages/${messageId}/invite`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response }) });
			const data = await result.json().catch(() => ({})) as { error?: string; eventId?: string | null; replySent?: boolean };
			if (!result.ok) throw new Error(data.error ?? t("invite.failed"));
			setAnswered(response);
			setEventId(data.eventId ?? null);
			toast.success(response === "declined" ? t("invite.declined") : t("invite.added"));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("invite.failed"));
		} finally {
			setPending(null);
		}
	}

	return (
		<section className="mt-6 rounded-xl border border-neutral-200 bg-neutral-50 p-4 sm:ml-16">
			<div className="flex items-start gap-3">
				<CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
				<div className="min-w-0 flex-1">
					<p className="text-xs font-medium uppercase text-neutral-500">{cancelled ? t("invite.cancelled") : t("invite.heading")}</p>
					<h2 className="mt-0.5 break-words text-base font-semibold text-neutral-900">{invite.title}</h2>
					<p className="mt-1 text-sm text-neutral-700">{when}</p>
					{invite.location && <p className="mt-0.5 break-words text-sm text-neutral-600">{invite.location}</p>}
					{invite.organizer && <p className="mt-0.5 text-sm text-neutral-600">{t("invite.organizer", { organizer: invite.organizer })}</p>}
					<div className="mt-3 flex flex-wrap items-center gap-2">
						{cancelled ? (
							<Button disabled={pending !== null || !eventId} onClick={() => void respond("declined")} variant="outline">{t("invite.removeFromCalendar")}</Button>
						) : (
							<>
								<Button disabled={pending !== null} onClick={() => void respond("accepted")} aria-pressed={answered === "accepted"}>{t("invite.accept")}</Button>
								<Button disabled={pending !== null} onClick={() => void respond("tentative")} variant="outline" aria-pressed={answered === "tentative"}>{t("invite.maybe")}</Button>
								<Button disabled={pending !== null} onClick={() => void respond("declined")} variant="outline" aria-pressed={answered === "declined"}>{t("invite.decline")}</Button>
							</>
						)}
						{eventId && answered !== "declined" && <a href={`/calendar?event=${eventId}`} className="text-sm font-medium text-blue-700 hover:underline">{t("invite.viewOnCalendar")}</a>}
					</div>
				</div>
			</div>
		</section>
	);
}
