"use client";

import { useMemo } from "react";
import clsx from "clsx";
import { useLanguage } from "@/components/language-provider";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { formatUserDate } from "@/lib/time/utils";
import { addDays, dateKey, EVENT_COLOR_CLASSES, formatEventRange, isPendingInvite, monthGridDates, PAST_EVENT_COLOR_CLASSES, PENDING_EVENT_CLASSES } from "./utils";
import type { CalendarEvent } from "./types";

const MAX_VISIBLE = 3;

type MonthGridProps = {
	month: Date;
	today: Date;
	events: CalendarEvent[];
	currentTime: number;
	onSelectDay: (day: Date) => void;
	onOpenDay: (day: Date) => void;
	onEdit: (event: CalendarEvent) => void;
};

export function MonthGrid({ month, today, events, currentTime, onSelectDay, onOpenDay, onEdit }: MonthGridProps) {
	const { t } = useLanguage();
	const dates = useMemo(() => monthGridDates(month), [month]);
	const monthKey = dateKey(month).slice(0, 7);
	const todayKey = dateKey(today);
	const byDay = useMemo(() => {
		const map = new Map<string, CalendarEvent[]>();
		for (const day of dates) {
			const next = addDays(day, 1);
			const list = events
				.filter((event) => new Date(event.startsAt) < next && new Date(event.endsAt) > day)
				.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
			map.set(dateKey(day), list);
		}
		return map;
	}, [dates, events]);

	return (
		<div className="flex min-h-full min-w-[640px] flex-col">
			<div className="sticky top-0 z-30 grid grid-cols-7 border-b border-neutral-200 bg-white">
				{([0, 1, 2, 3, 4, 5, 6] as const).map((weekday) => (
					<span key={weekday} className="px-2 py-2 text-xs font-medium text-neutral-600">{t(`calendar.weekdayShort.${weekday}`)}</span>
				))}
			</div>
			<div className="grid flex-1 grid-cols-7 grid-rows-6">
				{dates.map((day) => {
					const key = dateKey(day);
					const list = byDay.get(key) ?? [];
					const outside = key.slice(0, 7) !== monthKey;
					const extra = list.length - MAX_VISIBLE;
					return (
						<div key={key} className="relative min-h-28 border-b border-l border-neutral-100 p-1">
							<button type="button" aria-label={t("calendar.addEventOn", { date: formatUserDate(day, { dateStyle: "short" }) })} onClick={() => onSelectDay(day)} className="absolute inset-0 z-0 cursor-pointer" />
							<button type="button" onClick={() => onOpenDay(day)} className={clsx("relative z-10 mx-auto mb-1 flex h-7 w-7 items-center justify-center rounded-full text-sm font-medium hover:bg-neutral-100",
								key === todayKey ? "bg-blue-600 text-white hover:bg-blue-600" : outside ? "text-neutral-400" : "text-neutral-800")}>
								{formatUserDate(day, { day: "numeric" })}
							</button>
							<div className="relative z-10 space-y-0.5">
								{list.slice(0, MAX_VISIBLE).map((event) => {
									const color = normalizeCalendarColor(event.color);
									const past = new Date(event.endsAt).getTime() <= currentTime;
									return (
										<button key={`${event.id}-${event.startsAt}`} type="button" onClick={() => onEdit(event)} title={`${event.title} · ${formatEventRange(event)}`}
											className={clsx("block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] font-medium hover:brightness-95", isPendingInvite(event) ? PENDING_EVENT_CLASSES : past ? PAST_EVENT_COLOR_CLASSES[color] : EVENT_COLOR_CLASSES[color])}>
											{event.title}
										</button>
									);
								})}
								{extra > 0 && (
									<button type="button" onClick={() => onOpenDay(day)} className="block w-full rounded px-1.5 text-left text-[11px] font-medium text-neutral-600 hover:bg-neutral-100">
										{t("calendar.moreEvents", { count: extra })}
									</button>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
