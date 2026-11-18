import type { CalendarRepeat } from "./types";
import { createCalendarInvitation } from "./utils";

/** One side of a "this and following" split announcement: the stored row values the ICS is built from. */
export type SplitAnnouncementSide = {
	uid: string;
	title: string;
	description: string;
	location: string;
	startsAt: Date;
	endsAt: Date;
	repeat: CalendarRepeat;
	repeatDays: number[];
	repeatAnchorDay: number | null;
	/**
	 * Exclusive end of the series. It is written as the RRULE UNTIL verbatim, the same convention the
	 * series writer uses everywhere; Mailflare's own parser re-adds its one-second inclusive pad on read.
	 */
	repeatUntil: Date | null;
	repeatInterval: number;
	repeatWeekday: number | null;
	repeatWeek: number | null;
	reminderMinutes: number | null;
	excludedOccurrences: number[];
	overrides: { recurrenceId: Date; startsAt: Date; endsAt: Date }[];
	sequence: number;
};

/**
 * Guest announcement for a "this and following" split. Two files, because the truncation and the fork
 * are different series under different UIDs:
 * (1) truncation under the ORIGINAL uid: the ORIGINAL DTSTART with the full repeat context, UNTIL at
 * the split, the EXDATEs and the pre-split overrides. The original DTSTART must stay first: sending the
 * fork's later DTSTART with UNTIL at the split would describe an empty recurrence set.
 * (2) invitation under the FORK's uid: the fork times as a new series with its own repeat context.
 */
export function buildSplitAnnouncement(args: { original: SplitAnnouncementSide; fork: SplitAnnouncementSide; organizer: string; attendees: string[] }): { truncationFile: ArrayBuffer; forkFile: ArrayBuffer } {
	const fileFor = (side: SplitAnnouncementSide) => createCalendarInvitation({
		title: side.title, description: side.description, location: side.location,
		startsAt: side.startsAt, endsAt: side.endsAt, uid: side.uid,
		organizer: args.organizer, attendees: args.attendees, sequence: side.sequence,
		reminderMinutes: side.reminderMinutes,
		repeat: side.repeat, repeatDays: side.repeatDays, repeatAnchorDay: side.repeatAnchorDay,
		repeatUntil: side.repeatUntil, repeatInterval: side.repeatInterval,
		repeatWeekday: side.repeatWeekday, repeatWeek: side.repeatWeek,
		excludedOccurrences: side.excludedOccurrences, overrides: side.overrides,
	});
	return { truncationFile: fileFor(args.original), forkFile: fileFor(args.fork) };
}
