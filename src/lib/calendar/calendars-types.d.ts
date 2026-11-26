export type CalendarSummary = {
	id: string;
	/** Null for a default calendar that was never renamed; the UI shows its own label. */
	name: string | null;
	/** `#rrggbb` from the shared palette. */
	color: string;
	description: string;
	isDefault: boolean;
	/** CS-2 lists only the user's own calendars; sharing adds the other roles. */
	role: "owner";
};

export type CalendarInput = { name?: unknown; color?: unknown; description?: unknown };

export type CalendarFailure = { ok: false; status: 400 | 404 | 409; error: string };
export type CalendarResult = { ok: true; calendar: CalendarSummary } | CalendarFailure;
export type CalendarDeleteResult = { ok: true; name: string | null; eventCount: number } | CalendarFailure;
export type EventCalendarResult = { ok: true; calendarId: string | null | undefined } | CalendarFailure;
