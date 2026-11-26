import type { ImportGroup } from "./ics-import-types";

export type ImportGroupIds = {
	/** The id an emailed invitation with this UID would have (`inv_…`). */
	incId: string;
	/** The Mailflare event a UID ending in `@mailflare` names, when the UID has that form. */
	ownId: string | null;
	masterId: string | null;
	/** One id per override, in the order of `group.overrides`. */
	overrideIds: string[];
};

export type PlannedGroup = { group: ImportGroup; ids: ImportGroupIds };

export type CalendarImportRow = {
	id: string;
	userId: string;
	mailboxId: null;
	title: string;
	description: string;
	location: string;
	attendees: string;
	color: string;
	repeat: "none" | "daily" | "weekly" | "monthly" | "weekdays" | "yearly";
	repeatDays: string;
	repeatAnchorDay: number | null;
	repeatUntil: Date | null;
	excludedOccurrences: string;
	timeZone: string;
	startsAt: Date;
	endsAt: Date;
	reminderMinutes: number | null;
};

export type CalendarImportPlan = {
	rows: CalendarImportRow[];
	imported: number;
	skipped: number;
	simplified: number;
	guessedZone: number;
};

export type CalendarImportSummary = {
	imported: number;
	skipped: number;
	simplified: number;
	guessedZone: number;
	failed: number;
	errors: string[];
};
