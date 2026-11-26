import type { CalendarRole } from "./shares-types";

export type CalendarSummary = {
	id: string;
	/** Null for a default calendar that was never renamed; the UI shows its own label. */
	name: string | null;
	/** `#rrggbb` from the shared palette. */
	color: string;
	description: string;
	isDefault: boolean;
	/** "owner" for the user's own calendars, else the role they were granted. */
	role: CalendarRole;
	/** Set on calendars shared with the user: whose they are (a calendar without a name of its own is labelled with it). */
	ownerName?: string;
	/** Set with `ownerName`: the owner's user id, so the editor offers an event only calendars of its own owner. */
	ownerId?: string;
	/** Events in this calendar, for the delete confirmation. */
	eventCount: number;
};

export type CalendarInput = { name?: unknown; color?: unknown; description?: unknown };

export type CalendarFailure = { ok: false; status: 400 | 404 | 409; error: string };
export type CalendarResult = { ok: true; calendar: CalendarSummary } | CalendarFailure;
export type CalendarDeleteResult = { ok: true; name: string | null; eventCount: number } | CalendarFailure;
export type EventCalendarResult = { ok: true; calendarId: string | null | undefined } | CalendarFailure;
