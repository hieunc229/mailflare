"use client";

import { useId } from "react";
import { AlertCircle, Loader2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { formatUserDate } from "@/lib/time/utils";
import { MAX_GUESTS, busyBlocks, overlapsAny } from "./availability-utils";
import type { PersonAvailability } from "./availability-api";

const touch = "[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";

/** `label` is what the row is called when it is not an address: a room's name. */
export type AvailabilityRow = { address: string; availability: PersonAvailability; label?: string };
export type FindState = { state: "idle" | "loading" | "error" | "ready"; slots: { start: Date; end: Date }[] };

export type AvailabilityViewProps = {
	/** The organiser's time zone: times and the day shown follow it. */
	zone: string;
	guestCount: number;
	/** More guests than the server answers for: only the first 50 are shown. */
	truncated: boolean;
	state: "loading" | "error" | "ready";
	rows: AvailabilityRow[];
	dayStart: Date | null;
	dayEnd: Date | null;
	event: { start: Date | null; end: Date | null };
	find: FindState;
	canFind: boolean;
	/** The list was full, so the organiser's own calendar was left out of the suggestions. */
	selfLeftOut?: boolean;
	/** The event is longer than a working day, so no slot could ever fit. */
	tooLong?: boolean;
	onRetry: () => void;
	onFind: () => void;
	onPick: (slot: { start: Date; end: Date }) => void;
};

const clock = (date: Date, zone: string) => formatUserDate(date, { hour: "numeric", minute: "2-digit", timeZone: zone });

/**
 * Presentation only: who is free when the event is, for the day it is on (spec F9 8.6). Colour is never the only signal: each
 * row says in words whether it clashes with the event, and a screen reader gets the busy times as text while the bar is hidden.
 */
export function AvailabilityView(props: AvailabilityViewProps) {
	const { t } = useLanguage();
	const titleId = useId();
	const suggestedId = useId();
	const { zone, dayStart, dayEnd, event } = props;
	const span = dayStart && dayEnd && event.start && event.end ? busyBlocks([[event.start.toISOString(), event.end.toISOString()]], dayStart, dayEnd)[0] : undefined;
	if (props.guestCount === 0) return <p className="text-xs text-neutral-600">{t("calendar.availability.hint")}</p>;
	const dayLabel = dayStart ? formatUserDate(dayStart, { weekday: "short", month: "short", day: "numeric", timeZone: zone }) : "";
	const announcement = props.find.state === "loading" ? t("calendar.availability.finding") : props.find.state === "ready" ? t(props.find.slots.length ? "calendar.availability.suggested" : "calendar.availability.findEmpty")
		: props.state === "loading" ? t(props.rows.length ? "calendar.availability.updating" : "calendar.availability.loading") : "";
	const anyVisible = props.rows.some((row) => row.availability.status === "ok");
	return (
		<section aria-labelledby={titleId} className="space-y-2 text-sm">
			<div className="flex flex-wrap items-baseline justify-between gap-x-3">
				<h3 id={titleId} className="flex items-center gap-1.5 text-xs font-semibold text-neutral-900">{t("calendar.availability.title")}{props.state === "loading" && props.rows.length > 0 && <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin motion-reduce:animate-none" />}</h3>
				{dayLabel && <span className="text-xs text-neutral-600">{t("calendar.availability.day", { date: dayLabel })}</span>}
			</div>
			{/* The one live region: always mounted, so its text changing is what gets announced. The visible messages below are plain text. */}
			<p role="status" className="sr-only">{announcement}</p>
			{props.state === "loading" && props.rows.length === 0 && <p className="flex items-center gap-2 text-neutral-600"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("calendar.availability.loading")}</p>}
			{props.state === "error" && (
				<div role="alert" className="flex flex-wrap items-center gap-2 text-red-700">
					<AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
					<span className="min-w-0 flex-1">{t("calendar.availability.failed")}</span>
					<button type="button" onClick={props.onRetry} className={`rounded-md px-2 font-medium text-blue-700 underline hover:bg-blue-50 ${focus} ${touch}`}>{t("calendar.availability.retry")}</button>
				</div>
			)}
			{(props.state === "ready" || (props.state === "loading" && props.rows.length > 0)) && (
				<ul aria-busy={props.state === "loading" ? true : undefined} className={`space-y-2 ${props.state === "loading" ? "opacity-60" : ""}`}>
					{props.rows.map(({ address, availability, label }) => {
						const who = label ?? address;
						const blocks = availability.status === "ok" && dayStart && dayEnd ? busyBlocks(availability.busy, dayStart, dayEnd) : [];
						const clash = availability.status === "ok" && event.start && event.end ? overlapsAny(availability.busy, event.start, event.end) : false;
						const times = blocks.map((block) => t("calendar.availability.range", { from: clock(block.from, zone), to: clock(block.to, zone) })).join(", ");
						return (
							<li key={address} className="space-y-1">
								<div className="flex flex-wrap items-baseline justify-between gap-x-3">
									<span className="min-w-0 truncate font-medium text-neutral-900">{who}</span>
									{availability.status === "unknown"
										? <span className="text-xs text-neutral-600">{t("calendar.availability.noAccess")}</span>
										: <span className={`text-xs ${clash ? "font-medium text-red-700" : "text-neutral-600"}`}>{t(clash ? "calendar.availability.conflict" : "calendar.availability.free")}</span>}
								</div>
								{availability.status === "ok" && (
									<div aria-hidden="true" className="relative h-5 overflow-hidden rounded bg-neutral-100">
										{blocks.map((block) => <span key={block.from.getTime()} data-busy-block aria-hidden="true" style={{ left: `${block.left}%`, width: `${block.width}%` }} className="absolute inset-y-0 bg-blue-600" />)}
										{span && <span data-event-span aria-hidden="true" title={t("calendar.availability.eventMarker")} style={{ left: `${span.left}%`, width: `${span.width}%` }} className="pointer-events-none absolute inset-y-0 border-x-2 border-neutral-900 bg-neutral-900/10" />}
									</div>
								)}
								<span className="sr-only">{availability.status === "unknown" ? t("calendar.availability.noAccessFor", { name: who }) : blocks.length ? t("calendar.availability.busyAt", { name: who, times }) : t("calendar.availability.freeAllDay", { name: who })}</span>
							</li>
						);
					})}
				</ul>
			)}
			{props.truncated && <p className="text-xs text-neutral-600">{t("calendar.availability.truncated", { count: MAX_GUESTS })}</p>}
			<div className="space-y-2 pt-1">
				<button type="button" onClick={props.onFind} disabled={!props.canFind || props.find.state === "loading"} className={`rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 ${focus} ${touch}`}>{t("calendar.availability.find")}</button>
				{props.tooLong && <p className="text-xs text-neutral-600">{t("calendar.availability.findTooLong")}</p>}
				{props.state === "ready" && !anyVisible && !props.tooLong && <p className="text-xs text-neutral-600">{t("calendar.availability.findNeedsPeople")}</p>}
				<div className="space-y-1">
					{props.find.state === "loading" && <p className="flex items-center gap-2 text-neutral-600"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("calendar.availability.finding")}</p>}
					{props.find.state === "error" && <p role="alert" className="text-red-700">{t("calendar.availability.findFailed")}</p>}
					{props.find.state === "ready" && props.find.slots.length === 0 && <p className="text-neutral-600">{t("calendar.availability.findEmpty")}</p>}
					{props.find.state === "ready" && props.selfLeftOut && <p className="text-xs text-neutral-600">{t("calendar.availability.findSelfLeftOut")}</p>}
					{props.find.state === "ready" && props.find.slots.length > 0 && (
						<div className="space-y-1">
							<p id={suggestedId} className="text-xs font-semibold text-neutral-900">{t("calendar.availability.suggested")}</p>
							<ul aria-labelledby={suggestedId} className="flex flex-wrap gap-2">
								{props.find.slots.map((slot) => {
									const label = `${formatUserDate(slot.start, { weekday: "short", month: "short", day: "numeric", timeZone: zone })}, ${t("calendar.availability.range", { from: clock(slot.start, zone), to: clock(slot.end, zone) })}`;
									return <li key={slot.start.getTime()}><button type="button" aria-label={t("calendar.availability.use", { time: label })} onClick={() => props.onPick(slot)} className={`rounded-full border border-blue-600 px-3 py-1 text-sm text-blue-700 hover:bg-blue-50 ${focus} ${touch}`}>{label}</button></li>;
								})}
							</ul>
						</div>
					)}
				</div>
			</div>
		</section>
	);
}
