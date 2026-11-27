"use client";

import { useLanguage } from "@/components/language-provider";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatEventRange } from "./utils";
import type { CalendarEvent } from "./types";

/** What a viewer may see of an event they cannot change: a reader's view of a shared calendar. Redacted events say only that the time is taken. */
export function EventDetails({ event, calendarName, roomName }: { event: CalendarEvent; calendarName: string; /** Set for a booking from a room's schedule, which is in no calendar of the viewer's. */ roomName?: string }) {
	const { t } = useLanguage();
	return (
		<div className="space-y-1.5 text-sm text-neutral-700">
			<p>{formatEventRange(event)}</p>
			{event.location && <p className="break-words text-neutral-600">{event.location}</p>}
			{event.description && <p className="whitespace-pre-wrap break-words text-neutral-600">{event.description}</p>}
			<p className="text-neutral-600">{roomName ? t("calendar.rooms.eventRoom", { name: roomName }) : t("calendar.share.eventCalendar", { name: calendarName })}</p>
			<p className="text-xs text-neutral-600">{t("calendar.share.viewOnly")}</p>
		</div>
	);
}

export function EventViewDialog({ event, calendarName, roomName, onClose }: { event: CalendarEvent | null; calendarName: string; roomName?: string; onClose: () => void }) {
	const { t } = useLanguage();
	return (
		<Dialog open={event !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
			<DialogContent className="max-h-[calc(100vh-4rem)] w-[min(480px,calc(100vw-32px))] overflow-y-auto">
				{event && (
					<>
						<DialogHeader>
							<DialogTitle className="break-words">{event.redacted ? t("calendar.busy") : event.title}</DialogTitle>
							<DialogDescription className="sr-only">{t("calendar.share.viewOnly")}</DialogDescription>
						</DialogHeader>
						<EventDetails event={event} calendarName={calendarName} roomName={roomName} />
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
