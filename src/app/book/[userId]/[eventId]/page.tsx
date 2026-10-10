"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Globe2, MapPin, Users } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { LanguageSelector } from "@/components/language-selector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useBranding } from "@/components/branding-provider";
import { RouteLoadingBar } from "@/components/route-loading-bar";
import { getDisplayLocale, getUserTimeZone } from "@/lib/time/utils";
import type { BookingSlot, PublicBookingEvent } from "../types";
import { bookingTimeZones, calendarDays, formatCalendarDate, localDateForSlot, moveMonth, readBookingPageSelection, submitPublicBooking, writeBookingPageSelection } from "./utils";
import { BookingDetailSkeleton } from "./booking-detail-skeleton";

export default function PublicBookingEventPage() {
	const { t } = useLanguage();
	const branding = useBranding();
	const params = useParams();
	const userId = typeof params.userId === "string" ? params.userId : undefined;
	const eventId = typeof params.eventId === "string" ? params.eventId : undefined;
	const username = typeof params.username === "string" ? params.username : undefined;
	const slug = typeof params.slug === "string" ? params.slug : undefined;
	const identifier = slug ?? eventId ?? "";
	const endpoint = `/api/public/booking/${encodeURIComponent(identifier)}${username ? `?username=${encodeURIComponent(username)}` : ""}`;
	const [event, setEvent] = useState<PublicBookingEvent | null>(null);
	const [hostName, setHostName] = useState("");
	const [slots, setSlots] = useState<BookingSlot[]>([]);
	const [timeZone, setTimeZone] = useState("UTC");
	const [month, setMonth] = useState("");
	const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
	const [selectedSlot, setSelectedSlot] = useState<BookingSlot | null>(null);
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [guestEmails, setGuestEmails] = useState("");
	const [showGuests, setShowGuests] = useState(false);
	const [notes, setNotes] = useState("");
	const [loading, setLoading] = useState(true);
	const [submitting, setSubmitting] = useState(false);
	const [done, setDone] = useState(false);
	const [error, setError] = useState("");
	const slotsByDate = useMemo(() => {
		const grouped = new Map<string, BookingSlot[]>();
		for (const slot of slots) {
			const date = localDateForSlot(slot, timeZone);
			grouped.set(date, [...(grouped.get(date) ?? []), slot]);
		}
		return grouped;
	}, [slots, timeZone]);
	const availableDates = [...slotsByDate.keys()].sort();
	const todayDate = localDateForSlot({ startsAt: new Date().toISOString(), endsAt: "", localDate: "", time: "" }, timeZone);
	const visibleMonth = month || localDateForSlot({ startsAt: new Date().toISOString(), endsAt: "", localDate: "", time: "" }, timeZone).slice(0, 7);
	const firstMonth = availableDates[0]?.slice(0, 7);
	const lastMonth = availableDates.at(-1)?.slice(0, 7);
	const timeZones = useMemo(() => event ? bookingTimeZones(event.timeZone, timeZone) : [], [event, timeZone]);

	useEffect(() => {
		function restoreSelection() {
			const selection = readBookingPageSelection(window.location.search);
			const zone = selection.timeZone ?? getUserTimeZone();
			const viewerToday = localDateForSlot({ startsAt: new Date().toISOString(), endsAt: "", localDate: "", time: "" }, zone);
			const slot = slots.find((item) => item.startsAt === selection.slotStartsAt) ?? null;
			const date = slot ? localDateForSlot(slot, zone) : selection.date ?? viewerToday;
			setTimeZone(zone);
			setSelectedDate(date);
			setSelectedSlot(slot);
			setMonth(date.slice(0, 7));
			if (!loading || !selection.slotStartsAt) {
				if (selection.date !== date || (new URLSearchParams(window.location.search).has("slot") && !slot) || !selection.timeZone) writeBookingPageSelection(date, slot?.startsAt ?? null, zone, true);
			}
		}
		restoreSelection();
		window.addEventListener("popstate", restoreSelection);
		return () => window.removeEventListener("popstate", restoreSelection);
	}, [slots, loading]);

	useEffect(() => {
		let active = true;
		void fetch(endpoint).then(async (response) => {
			if (!response.ok) throw new Error();
			return response.json() as Promise<{ event: PublicBookingEvent; hostName: string; slots: BookingSlot[] }>;
		}).then((data) => {
			if (!active) return;
			if (userId && data.event.userId !== userId) throw new Error();
			setEvent(data.event);
			setHostName(data.hostName);
			setSlots(data.slots);
		}).catch(() => { if (active) setError(t("public.unavailable")); }).finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, [endpoint, userId, t]);

	async function book() {
		if (!selectedSlot) return;
		setSubmitting(true);
		setError("");
		try {
			await submitPublicBooking(endpoint, selectedSlot.startsAt, name, email, guestEmails, notes);
			setDone(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("public.bookFailed"));
		} finally { setSubmitting(false); }
	}

	return <main className="page-transition-enter min-h-dvh bg-[#f6f8fc] p-4 text-neutral-900 max-sm:px-0 max-sm:pb-0 sm:px-6 lg:h-dvh lg:overflow-hidden lg:pb-0">
		<div className="mx-auto max-w-[1500px] lg:flex lg:h-full lg:min-h-0 lg:flex-col">
			{loading && <RouteLoadingBar />}
			{selectedSlot && !done ? <button type="button" onClick={() => { setSelectedSlot(null); setError(""); writeBookingPageSelection(selectedDate, null, timeZone, true); }} className="mb-5 inline-flex items-center gap-2 self-start text-sm text-neutral-600 hover:text-blue-700 max-sm:ml-4"><ArrowLeft className="h-4 w-4" />{t("public.backToCalendar")}</button> : <Link href={username ? `/c/${username}` : `/book/${userId}`} className="mb-5 inline-flex items-center gap-2 self-start text-sm text-neutral-600 hover:text-blue-700 max-sm:ml-4"><ArrowLeft className="h-4 w-4" />{t("public.allMeetings")}</Link>}
			{loading ? <BookingDetailSkeleton /> : !event ? <p className="rounded-2xl bg-white p-8 text-sm text-neutral-600 shadow-sm">{error}</p> :
				<div className={`page-transition-enter grid overflow-hidden rounded-t-3xl bg-white shadow-xl shadow-neutral-200/50 lg:min-h-0 lg:flex-1 ${selectedSlot || done ? "lg:grid-cols-[minmax(260px,1fr)_minmax(420px,2fr)]" : "lg:grid-cols-[minmax(240px,.95fr)_minmax(380px,1.65fr)_minmax(240px,.95fr)]"}`}>
					<aside className="min-w-0 border-b border-neutral-200 p-7 max-sm:p-5 sm:p-9 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 flex flex-col border-r">
						<h1 className="text-xl font-semibold tracking-tight">{event.name}</h1>

						{event.description && <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-neutral-600">{event.description}</p>}

						<div className="mt-4 space-y-5 text-sm font-medium text-neutral-600 border-t border-neutral-100 pt-4">
							<p className="flex items-start gap-3"><Clock3 size={18} className="shrink-0 text-neutral-600" />{t("public.minutes", { count: event.durationMinutes })}</p>
							{event.location && <p className="flex items-start gap-3"><MapPin size={18} className="shrink-0 text-neutral-600" />{event.location}</p>}
							{selectedSlot && <><p className="flex items-start gap-3"><CalendarDays size={18} className="shrink-0 text-neutral-600" /><span>{new Intl.DateTimeFormat(getDisplayLocale(), { hour: "numeric", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(selectedSlot.startsAt))} – {new Intl.DateTimeFormat(getDisplayLocale(), { hour: "numeric", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(selectedSlot.endsAt))}, {new Intl.DateTimeFormat(getDisplayLocale(), { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone }).format(new Date(selectedSlot.startsAt))}</span></p><p className="flex items-start gap-3"><Globe2 size={18} className="shrink-0 text-neutral-600" />{timeZone.replaceAll("_", " ")}</p></>}
							{hostName && <p className="flex items-start gap-3"><Users size={18} className="shrink-0 text-neutral-600" /><span>{hostName}</span></p>}

						</div>


						<span className="flex-1 max-sm:hidden" />
						<div className="mb-4 max-w-48"><LanguageSelector /></div>
						<div className="flex min-w-0 items-center gap-3 max-sm:order-first max-sm:mb-5">

							<img src={branding.iconUrl} width={24} height={24} alt={branding.appName || "Mailflare"} />

							<span className="truncate font-semibold">{branding.appName}</span>
						</div>
					</aside>
					{done ? <section className="flex min-h-0 flex-col items-center justify-center px-8 py-20 text-center"><div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-green-700"><Check className="h-7 w-7" /></div><h2 className="text-2xl font-semibold">{t("public.booked")}</h2><p className="mt-3 text-sm text-neutral-500">{t("public.scheduledFor", { when: selectedSlot ? new Intl.DateTimeFormat(getDisplayLocale(), { dateStyle: "full", timeStyle: "short", timeZone }).format(new Date(selectedSlot.startsAt)) : "" })}</p></section> : selectedSlot ?
						<form onSubmit={(formEvent) => { formEvent.preventDefault(); void book(); }} className="page-transition-enter min-h-0 space-y-6 overflow-y-auto p-7 max-sm:p-5 sm:p-10">
							<h2 className="text-2xl font-medium">{t("public.enterDetails")}</h2>
							<label className="block text-sm font-medium text-neutral-700">{t("public.name")} <span aria-hidden="true">*</span><Input required value={name} onChange={(input) => setName(input.target.value)} maxLength={120} autoComplete="name" className="mt-2" /></label>
							<label className="block text-sm font-medium text-neutral-700">{t("public.email")} <span aria-hidden="true">*</span><Input required type="email" value={email} onChange={(input) => setEmail(input.target.value)} maxLength={254} autoComplete="email" className="mt-2" /></label>
							{showGuests ? <label className="block text-sm font-medium text-neutral-700">{t("public.guestEmails")} <span className="font-normal text-neutral-500">{t("public.commaSeparated")}</span><Input type="text" value={guestEmails} onChange={(input) => setGuestEmails(input.target.value)} placeholder="guest@example.com" className="mt-2" /></label> : <Button type="button" variant="outline" onClick={() => setShowGuests(true)} className="rounded-full text-blue-700">{t("public.addGuests")}</Button>}
							<label className="block text-sm font-medium text-neutral-700">{t("public.notes")}<Textarea value={notes} onChange={(input) => setNotes(input.target.value)} maxLength={2000} rows={4} className="mt-2 resize-y" /></label>
							{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
							<Button type="submit" disabled={submitting || !name.trim() || !email.trim()} className="h-11 rounded-full bg-blue-600 px-7 text-sm font-medium hover:bg-blue-700">{submitting ? t("public.booking") : t("public.schedule")}</Button>
						</form> : <>
							<section className="page-transition-enter min-w-0 border-b border-neutral-200 lg:min-h-0 lg:overflow-y-auto">
								<div className="mx-auto md:mt-8 my-2 flex max-w-[440px] items-center justify-between gap-3 px-5"><h3 className="text-lg font-semibold flex-1">{formatCalendarDate(`${visibleMonth}-01`, { month: "long", year: "numeric" })}</h3>
									<button type="button" aria-label={t("public.prevMonth")} disabled={!firstMonth || moveMonth(visibleMonth, -1) < firstMonth} onClick={() => setMonth(moveMonth(visibleMonth, -1))} className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-200 text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-30"><ChevronLeft className="h-5 w-5" /></button>
									<button type="button" aria-label={t("public.nextMonth")} disabled={!lastMonth || moveMonth(visibleMonth, 1) > lastMonth} onClick={() => setMonth(moveMonth(visibleMonth, 1))} className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-200 text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-30"><ChevronRight className="h-5 w-5" /></button>
								</div>
								<div className="mx-auto mt-6 grid max-w-[440px] grid-cols-7 max-sm:px-5 text-center text-sm text-neutral-500">{t("public.weekdayHeads").split("|").map((head) => <span key={head}>{head}</span>)}</div>
								<div className="mx-auto mt-2 mb-6 grid max-w-[440px] grid-cols-7 max-sm:px-5">{calendarDays(visibleMonth).map((date, index) => <div key={date || `blank-${index}`} className="aspect-square min-w-0">{date && <button type="button" disabled={!slotsByDate.has(date) && date !== todayDate} onClick={() => { setSelectedDate(date); setError(""); writeBookingPageSelection(date, null, timeZone); }} aria-label={`${formatCalendarDate(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}${date === todayDate ? t("public.today") : ""}${slotsByDate.has(date) ? t("public.availableTimes", { count: slotsByDate.get(date)?.length }) : t("public.noTimesDay")}`} aria-current={date === todayDate ? "date" : undefined} aria-pressed={selectedDate === date} className={`flex h-full w-full items-center justify-center rounded-lg text-base ${selectedDate === date ? "bg-blue-600 text-white" : slotsByDate.has(date) || date === todayDate ? "text-blue-700 hover:bg-blue-50" : "cursor-not-allowed text-neutral-400"}`}><span className={`relative flex h-10 w-10 items-center justify-center rounded-full ${selectedDate === date ? "font-semibold" : slotsByDate.has(date) ? "bg-blue-50 font-medium" : ""} ${date === todayDate && selectedDate !== date ? "ring-2 ring-blue-300 ring-offset-2" : ""}`}>{Number(date.slice(-2))}{date === todayDate && selectedDate === date && <span aria-hidden="true" className="absolute bottom-1 h-1 w-1 rounded-full bg-white" />}</span></button>}</div>)}
								</div>

								<div className="flex min-w-0 items-center gap-2 w-full pl-3 pr-2 max-sm:px-5 text-sm text-neutral-600 focus-within:border-blue-600 max-w-[440px] my-4 mx-auto">
									<Globe2 aria-hidden="true" className="h-4 w-4 shrink-0" />
									<label htmlFor="booking-time-zone" className="shrink-0 whitespace-nowrap">{t("public.timeZone")}</label>
									<select id="booking-time-zone" value={timeZone} onChange={(input) => { const nextToday = localDateForSlot({ startsAt: new Date().toISOString(), endsAt: "", localDate: "", time: "" }, input.target.value); setTimeZone(input.target.value); setSelectedDate(nextToday); setMonth(nextToday.slice(0, 7)); writeBookingPageSelection(nextToday, null, input.target.value); }} className="ml-auto h-9 min-w-0 max-w-full flex-1 truncate border-0 bg-transparent px-1 text-sm text-neutral-700 shadow-none outline-none text-right">{timeZones.map((zone) => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}</select>
								</div>
								{slots.length === 0 && <p className="mt-6 text-sm text-neutral-500">{t("public.noTimes60")}</p>}
							</section>
							{selectedDate && <section key={selectedDate} className="page-transition-enter flex min-h-0 flex-col p-7 max-sm:p-5 sm:p-9 lg:overflow-hidden"><h3 className="mb-6 shrink-0 text-lg font-semibold">{formatCalendarDate(selectedDate, { weekday: "long", month: "short", day: "numeric" })}</h3><div className="min-h-0 max-h-[50dvh] flex-1 space-y-3 overflow-y-auto pr-1 lg:max-h-none">{(slotsByDate.get(selectedDate) ?? []).length === 0 ? <p className="text-sm text-neutral-500">{t("public.noTimesDate")}</p> : (slotsByDate.get(selectedDate) ?? []).map((slot) => <button type="button" key={slot.startsAt} onClick={() => { setSelectedSlot(slot); setError(""); writeBookingPageSelection(selectedDate, slot.startsAt, timeZone); }} className="w-full rounded-md border border-neutral-300 bg-white px-4 py-3 text-center text-sm font-medium text-blue-700 hover:border-blue-500 hover:bg-blue-50">{new Intl.DateTimeFormat(getDisplayLocale(), { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(new Date(slot.startsAt))}</button>)}</div></section>}
						</>}
				</div>}
		</div>
	</main>;
}
