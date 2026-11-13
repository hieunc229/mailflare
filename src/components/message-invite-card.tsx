"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import toast from "react-hot-toast";
import { CalendarDays, Check, X } from "@/components/icons";
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

export function MessageInviteCard({ messageId, hasCalendarAttachment, className }: { messageId: string; hasCalendarAttachment: boolean; className?: string }) {
	const { t } = useLanguage();
	const [invite, setInvite] = useState<InviteView | null>(null);
	const [eventId, setEventId] = useState<string | null>(null);
	const [answered, setAnswered] = useState<InviteResponse | null>(null);
	const [pending, setPending] = useState<InviteResponse | null>(null);

	// The caller keys this card by message, so state starts fresh for each message without resetting it here.
	useEffect(() => {
		if (!hasCalendarAttachment) return;
		let active = true;
		void authFetch(`/api/messages/${messageId}/invite`)
			.then(async (response) => (response.ok ? await response.json() as { invite: InviteView | null; eventId: string | null; response?: InviteResponse | null } : null))
			.then((data) => { if (active && data?.invite) { setInvite(data.invite); setEventId(data.eventId); setAnswered(data.response ?? null); } })
			.catch(() => undefined);
		return () => { active = false; };
	}, [messageId, hasCalendarAttachment]);

	if (!invite) return null;
	const cancelled = invite.method === "CANCEL";
	if (invite.method === "REPLY") {
		const answer = invite.attendees?.[0];
		const key = { ACCEPTED: "invite.reply.accepted", TENTATIVE: "invite.reply.tentative", DECLINED: "invite.reply.declined" }[answer?.status ?? ""];
		return (
			<section className={clsx("rounded-xl bg-[#f0f4f8] p-4", className)}>
				<div className="flex items-start gap-3">
					<CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
					<div className="min-w-0 flex-1">
						<p className="text-[11px] font-medium uppercase text-neutral-500">{t("invite.reply.heading")}</p>
						<h2 className="mt-0.5 break-words text-sm font-semibold text-neutral-900">{invite.title}</h2>
						{answer && key && <p className="mt-1 text-xs text-neutral-700">{t(key as Parameters<typeof t>[0], { guest: answer.email })}</p>}
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
		<section className={clsx("rounded-xl bg-[#f0f4f8] p-4", className)}>
			<div className="flex items-start gap-3">
				<CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
				<div className="min-w-0 flex-1">
					<p className="text-[11px] font-medium uppercase text-neutral-500">{cancelled ? t("invite.cancelled") : t("invite.heading")}</p>
					<h2 className="mt-0.5 break-words text-sm font-semibold text-neutral-900">{invite.title}</h2>
					<p className="mt-1 text-xs text-neutral-700">{when}</p>
					{invite.location && <p className="mt-0.5 break-words text-xs text-neutral-600">{invite.location}</p>}
					{invite.organizer && <p className="mt-0.5 text-xs text-neutral-600">{t("invite.organizer", { organizer: invite.organizer })}</p>}
					<div className="mt-3 flex flex-wrap items-center gap-2">
						{cancelled ? (
							<Button size="sm" disabled={pending !== null || !eventId} onClick={() => void respond("declined")} variant="outline" className="rounded-full border-0 bg-white text-neutral-700 hover:bg-neutral-50">{t("invite.removeFromCalendar")}</Button>
						) : (
							<>
								{(["accepted", "tentative", "declined"] as const).map((option) => {
									const selected = answered === option;
									const label = {
										accepted: selected ? t("invite.acceptedLabel") : t("invite.accept"),
										tentative: t("invite.maybe"),
										declined: selected ? t("invite.declinedLabel") : t("invite.decline"),
									}[option];
									const selectedColor = { accepted: "text-green-600", tentative: "text-orange-400", declined: "text-red-600" }[option];
									return <Button key={option} size="sm" disabled={pending !== null} onClick={() => void respond(option)} variant={answered === null && option === "accepted" ? "default" : "outline"} aria-pressed={selected} className={clsx("rounded-full", !(answered === null && option === "accepted") && "border-0 bg-white hover:bg-neutral-50", selected ? clsx("font-semibold", selectedColor) : "text-neutral-700", answered !== null && !selected && "opacity-50")}>{selected && option === "accepted" && <Check className="h-4 w-4" />}{selected && option === "declined" && <X className="h-4 w-4" />}{label}</Button>;
								})}
							</>
						)}
						{eventId && answered !== "declined" && <a href={`/calendar?event=${eventId}`} className="ml-auto text-xs font-medium text-blue-700 hover:underline">{t("invite.viewOnCalendar")}</a>}
					</div>
				</div>
			</div>
		</section>
	);
}
