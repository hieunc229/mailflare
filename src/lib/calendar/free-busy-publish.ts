import { busyIntervals, mergeBusy, type BusyInterval } from "./free-busy";
import { escapeIcsText, formatIcsUtc, joinIcsLines } from "./ics";

/** The published window (spec F9 D-11): the past week and the next eight weeks. */
export const PUBLISH_PAST_DAYS = 7;
export const PUBLISH_FUTURE_DAYS = 56;
const DAY = 86_400_000;
const PRODID = "PRODID:-//Mailflare//Free Busy//EN";

export function publishWindow(now: Date): { start: Date; end: Date } {
	return { start: new Date(now.getTime() - PUBLISH_PAST_DAYS * DAY), end: new Date(now.getTime() + PUBLISH_FUTURE_DAYS * DAY) };
}

/**
 * Busy times of one person over the published window. The window is 63 days and the free/busy service answers at most 62, so it is
 * asked in two halves and the answers joined (an event over the seam is clipped by both and merges back into one interval).
 */
export async function publishedBusy(env: CloudflareEnv, userId: string, now: Date): Promise<BusyInterval[]> {
	const { start, end } = publishWindow(now);
	const middle = new Date(Math.floor((start.getTime() + end.getTime()) / 2));
	const first = await busyIntervals(env, { userIds: [userId] }, start, middle);
	const second = await busyIntervals(env, { userIds: [userId] }, middle, end);
	return mergeBusy([...(first.get(userId) ?? []), ...(second.get(userId) ?? [])]);
}

type Render = { uid: string; now: Date };

/** `text/calendar` VFREEBUSY (.ifb): periods only, no organiser, attendee or text of any event. */
export function buildFreeBusyIfb(intervals: BusyInterval[], { uid, now, start, end }: Render & { start: Date; end: Date }): string {
	return joinIcsLines([
		"BEGIN:VCALENDAR", "VERSION:2.0", PRODID, "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
		"BEGIN:VFREEBUSY", `UID:${escapeIcsText(uid)}@mailflare`, `DTSTAMP:${formatIcsUtc(now)}`, `DTSTART:${formatIcsUtc(start)}`, `DTEND:${formatIcsUtc(end)}`,
		...intervals.map(([from, to]) => `FREEBUSY;FBTYPE=BUSY:${formatIcsUtc(new Date(from))}/${formatIcsUtc(new Date(to))}`),
		"END:VFREEBUSY", "END:VCALENDAR",
	]);
}

/** The same times as busy-only events, for calendar apps that subscribe to a URL (Google, Apple). UIDs depend on the time, not on when the file is fetched. */
export function buildFreeBusyIcs(intervals: BusyInterval[], { uid, now }: Render): string {
	return joinIcsLines([
		"BEGIN:VCALENDAR", "VERSION:2.0", PRODID, "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Busy",
		...intervals.flatMap(([from, to]) => {
			const startsAt = formatIcsUtc(new Date(from));
			return ["BEGIN:VEVENT", `UID:${escapeIcsText(uid)}-${startsAt}@mailflare`, `DTSTAMP:${formatIcsUtc(now)}`, `DTSTART:${startsAt}`, `DTEND:${formatIcsUtc(new Date(to))}`, "SUMMARY:Busy", "TRANSP:OPAQUE", "END:VEVENT"];
		}),
		"END:VCALENDAR",
	]);
}
