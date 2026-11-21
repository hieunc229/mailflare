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
	/** Step between recurrences: every N days/weeks/months/years (1..999). */
	repeatInterval?: number;
	/** Weekday (0-6) and week (1-5, -1 = last) of an nth-weekday monthly repeat; both set or both absent. */
	repeatWeekday?: number | null;
	repeatWeek?: number | null;
	reminderMinutes?: number | null;
	timeZone?: string;
	effectiveFrom?: string;
	moveOccurrenceToPast?: boolean;
	startsAt: string;
	endsAt: string;
	mailboxId?: string | null;
	from?: string;
};
