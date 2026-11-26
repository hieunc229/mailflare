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
	from?: string;
};
