import type { InviteRepeat } from "./invite";

export type ImportOptions = {
	/** The user's IANA zone: all-day dates, floating times and unknown TZIDs are read in it. */
	userZone: string;
	/** Lower-case addresses that mean "me": they are left out of attendees and decide declined events. */
	ownAddresses: string[];
	reminders: boolean;
	skipDeclined: boolean;
};

/** One event ready to become a `calendar_events` row. */
export type ImportEvent = {
	title: string;
	description: string;
	location: string;
	startsAt: Date;
	endsAt: Date;
	timeZone: string;
	repeat: InviteRepeat["repeat"];
	repeatDays: number[];
	repeatAnchorDay: number | null;
	repeatUntil: Date | null;
	/** Occurrence starts a series skips: EXDATEs, cancelled occurrences and the ones an override replaces. */
	excluded: Date[];
	reminderMinutes: number | null;
	attendees: string[];
	/** Set on an override: the occurrence of the series it replaces. */
	recurrenceId: Date | null;
};

/** The VEVENTs of one UID. */
export type ImportGroup = {
	uid: string;
	master: ImportEvent | null;
	overrides: ImportEvent[];
	/** The series had a rule Mailflare cannot store, so it is a single event on its first date. */
	simplified: boolean;
	/** A floating time or unknown TZID was read in the user's zone. */
	guessedZone: boolean;
	/** Events left out on purpose: cancelled or declined. */
	skipped: number;
	/** `<SUMMARY or UID>: reason` for events that could not be read. */
	failures: string[];
};

export type SplitIcsResult = {
	/** The VEVENT blocks of each UID, ready to send to the server. */
	groups: string[];
	eventCount: number;
	/** VEVENTs without a usable UID. */
	noUid: number;
	/** UIDs whose events were too many or too large to import. */
	tooBig: number;
	/** The file had more events than the cap; the rest were not read. */
	truncated: boolean;
};
