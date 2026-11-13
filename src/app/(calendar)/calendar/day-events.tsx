"use client";

import { Fragment, memo, useMemo } from "react";
import type { DragEvent, PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";
import { useLanguage } from "@/components/language-provider";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { addDays, dateKey, EVENT_COLOR_CLASSES, eventPosition, formatEventRange, isPendingInvite, PAST_EVENT_COLOR_CLASSES, PENDING_EVENT_CLASSES } from "./utils";
import type { CalendarEvent, EventResizeEdge } from "./types";
import type { DayEventsProps } from "./day-events-types";

// Memoized so pointer-move / drag-over preview updates in the page do not
// recompute positions (timezone math) and re-render every event block.
function DayEventsImpl({ day, events, currentTime, busy, activeEventId, onEdit, onDragStart, onDragEnd, onResizeStart, onResizeMove, onResizeEnd, onResizeCancel }: DayEventsProps) {
	const { t } = useLanguage();
	const nextDay = useMemo(() => addDays(day, 1), [day]);
	const items = useMemo(() => events.flatMap((event) => {
		if (!(new Date(event.startsAt) < nextDay && new Date(event.endsAt) > day)) return [];
		const position = eventPosition(event, day);
		if (!position) return [];
		return [{
			event,
			position,
			color: normalizeCalendarColor(event.color),
			range: formatEventRange(event),
			canResizeStart: dateKey(new Date(event.startsAt)) === dateKey(day),
			canResizeEnd: new Date(event.endsAt).getTime() <= nextDay.getTime(),
		}];
	}), [events, day, nextDay]);

	return (
		<>
			{items.map(({ event, position, color, range, canResizeStart, canResizeEnd }) => {
				const isPastEvent = new Date(event.endsAt).getTime() <= currentTime;
				const edges = (["start", "end"] as const).filter((edge) => edge === "start" ? canResizeStart : canResizeEnd);
				// Keep the grab zone inside the event so it never steals clicks from neighbours.
				const handleHeight = Math.max(4, Math.min(10, position.height / 3));
				return (
					<Fragment key={event.id}>
						<button type="button" draggable={!busy && !isPendingInvite(event)} onClick={() => onEdit(event)}
							onDragStart={(dragEvent: DragEvent<HTMLButtonElement>) => onDragStart(dragEvent, event)}
							onDragEnd={onDragEnd}
							title={`${event.title} · ${range}`}
							className={`absolute left-1 right-1 z-10 flex cursor-move flex-col items-start justify-start overflow-hidden rounded-lg pr-2 pl-4 text-left hover:brightness-95 ${isPendingInvite(event) ? PENDING_EVENT_CLASSES : isPastEvent ? PAST_EVENT_COLOR_CLASSES[color] : EVENT_COLOR_CLASSES[color]} ${position.height >= 20 ? "py-1.5" : "py-0"} ${activeEventId === event.id ? "opacity-40" : ""}`}
							style={{ top: position.top, height: position.height }}>
							<span className="absolute top-1 left-1 block h-[calc(100%-8px)] w-1 rounded-xl bg-current" />
							{position.height >= 15 && <span className="block w-full truncate text-[12px] font-semibold leading-4">{event.title}</span>}
							{position.height >= 34 && <span className="block w-full truncate text-[11px] leading-4 opacity-70">{range}</span>}
						</button>
						{!isPendingInvite(event) && edges.map((edge: EventResizeEdge) => (
							<button key={edge} type="button" draggable={false}
								aria-label={t(edge === "start" ? "calendar.resizeEdge.start" : "calendar.resizeEdge.end", { title: event.title })}
								onPointerDown={(pointerEvent: ReactPointerEvent<HTMLButtonElement>) => onResizeStart(pointerEvent, event, day, edge)}
								onPointerMove={onResizeMove}
								onPointerUp={onResizeEnd}
								onPointerCancel={onResizeCancel}
								onClick={(clickEvent) => clickEvent.stopPropagation()}
								className={clsx("absolute left-1 right-1 z-20 cursor-ns-resize touch-none bg-transparent focus-visible:outline-2 focus-visible:outline-blue-500")}
								style={{ height: handleHeight, top: edge === "start" ? position.top : position.top + position.height - handleHeight }} />
						))}
					</Fragment>
				);
			})}
		</>
	);
}

export const DayEvents = memo(DayEventsImpl);
export type { CalendarEvent };
