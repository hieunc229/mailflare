import type { CalendarRepeat } from "@/lib/calendar/types";

export type CalendarEventInput = {
	title: string;
	description?: string;
	location?: string;
	attendees?: string[];
	color?: string;
	repeat?: CalendarRepeat;
	repeatDays?: number[];
	repeatAnchorDay?: number;
	reminderMinutes?: number | null;
	/** CLASS:PRIVATE. Omitted keeps the stored value. */
	isPrivate?: boolean;
	/** Show as free (TRANSP:TRANSPARENT) instead of busy. Omitted keeps the stored value. */
	transparent?: boolean;
	timeZone?: string;
	effectiveFrom?: string;
	moveOccurrenceToPast?: boolean;
	startsAt: string;
	endsAt: string;
	mailboxId?: string | null;
	/** The calendar to write into: an owned calendar id, the default calendar's id or null for it. Omitted keeps the stored calendar (PATCH) or uses the default (POST). */
	calendarId?: string | null;
	from?: string;
	/** Rooms and equipment to book for the event (at most five). Omitted keeps the stored bookings (PATCH) or books none (POST); an empty list removes them. */
	resourceIds?: string[];
};
