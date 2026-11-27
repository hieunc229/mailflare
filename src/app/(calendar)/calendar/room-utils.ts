import type { CalendarRepeat } from "@/lib/calendar/types";
import type { CalendarEvent } from "./types";
import type { RoomOption, RoomScheduleEvent } from "./room-types";

/** Which rooms' schedules are shown is a per-browser choice, kept in localStorage like the hidden calendars. */
export const SHOWN_ROOMS_KEY = "mailflare.calendar.rooms.shown";
/** Rooms whose schedules one view asks for at once (the events API takes at most 20). */
export const MAX_SHOWN_ROOMS = 20;
/** Rooms on one event (spec F9 section 5). */
export const MAX_EVENT_ROOMS = 5;
const ROOM_EVENT_COLOR = "#0d9488";

export function readShownRooms(): string[] {
	try {
		const parsed: unknown = JSON.parse(window.localStorage.getItem(SHOWN_ROOMS_KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
	} catch { return []; }
}

export function writeShownRooms(ids: string[]): void {
	try { window.localStorage.setItem(SHOWN_ROOMS_KEY, JSON.stringify(ids)); } catch { /* not remembered */ }
}

/** Turns a room's schedule on or off; at most `MAX_SHOWN_ROOMS` stay on (the oldest choice drops out). */
export function toggleShownRoom(shown: string[], id: string): string[] {
	if (shown.includes(id)) return shown.filter((item) => item !== id);
	return [...shown, id].slice(-MAX_SHOWN_ROOMS);
}

/** Only rooms that still exist and are on: an id left in storage after a room was deleted or turned off is dropped. */
export const activeShownRooms = (shown: string[], rooms: RoomOption[]): string[] => shown.filter((id) => rooms.some((room) => room.id === id));

/**
 * A room's schedule as calendar events. Each is prefixed with its room, read-only (`role: "freebusy"` keeps it out of the editor and
 * the drag handlers) and teal. An event the viewer already has on their own calendars is left out, so it is not drawn twice.
 */
export function roomScheduleEvents(schedule: RoomScheduleEvent[], rooms: RoomOption[], ownEventIds: Set<string>, busyTitle: string): CalendarEvent[] {
	const names = new Map(rooms.map((room) => [room.id, room.name]));
	return schedule.filter((event) => !ownEventIds.has(event.id)).map((event) => ({
		id: `room:${event.resourceId}:${event.id}`,
		title: `${names.get(event.resourceId) ?? ""}: ${event.redacted ? busyTitle : event.title}`.replace(/^: /, ""),
		description: "", location: "", attendees: "[]", color: ROOM_EVENT_COLOR,
		startsAt: event.startsAt, endsAt: event.endsAt, repeat: event.repeat as CalendarRepeat, repeatDays: event.repeatDays, repeatAnchorDay: event.repeatAnchorDay,
		repeatUntil: event.repeatUntil, rrule: event.rrule, excludedOccurrences: event.excludedOccurrences, timeZone: event.timeZone,
		role: "freebusy" as const, redacted: event.redacted, roomId: event.resourceId,
	}));
}

/** The translation key for a refused booking, by status and code, so the server's English text is never shown. */
export function roomSaveErrorKey(status: number, code?: string): string | null {
	if (code === "TEAM_REQUIRED") return "calendar.rooms.error.team";
	if (code === "ROOM_UNKNOWN" || code === "TOO_MANY_ROOMS") return "calendar.rooms.error.invalid";
	return status === 403 || status === 400 ? "calendar.rooms.error.invalid" : null;
}
