import type { CalendarRole } from "./shares-types";
import { isOffCalendarResponse } from "./response-status";

/** The title every redacted event shows. The web UI swaps it for the viewer's language when `redacted` is set. */
export const BUSY_TITLE = "Busy";

type Viewable = {
	title: string;
	description: string;
	location: string;
	attendees: string;
	attendeeResponses?: string | null;
	mailboxId?: string | null;
	inviteMessageId?: string | null;
	inviteSender?: string | null;
	reminderMinutes?: number | null;
	lastRemindedStart?: Date | null;
	inviteSequence?: number | null;
	isPrivate?: boolean;
	transparent?: boolean;
	responseStatus?: string | null;
};

/**
 * What a viewer with `role` may see of an event (spec D-6), the one place that decides it: the events API, the feed and the
 * editor all go through here. The owner sees the row as stored. Everyone else never gets the owner's mailbox, the message an
 * invitation came from (or who sent it) or the owner's reminder setting. Below `edit`, a private event keeps only start, end, recurrence,
 * overrides and the free/busy flag; a `freebusy` viewer gets that for every event.
 */
export function redactEvent<T extends Viewable>(event: T, role: CalendarRole): T & { redacted?: true } {
	if (role === "owner") return event;
	const own = { ...event, mailboxId: null, inviteMessageId: null, inviteSender: null, reminderMinutes: null };
	const hidden = role === "freebusy" || ((role === "read") && event.isPrivate === true);
	if (!hidden) return own;
	return { ...own, title: BUSY_TITLE, description: "", location: "", attendees: "[]", attendeeResponses: null, responseStatus: null, inviteSequence: 0, lastRemindedStart: null, redacted: true };
}

/** Counts towards someone's busy time: not marked free, not an invitation still unanswered, declined or cancelled. */
export function isBusyEvent(event: { transparent?: boolean; responseStatus?: string | null }): boolean {
	return !event.transparent && !isOffCalendarResponse(event.responseStatus);
}
