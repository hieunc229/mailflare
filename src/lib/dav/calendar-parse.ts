import { addZonedDays, parseIcsDate, parseIcsDuration, unescapeText } from "@/lib/calendar/invite";
import { legacyRepeatFor, parseRrule } from "@/lib/calendar/rrule";
import { normalizeTimeZone } from "@/lib/time/utils";
import { isDavAddress } from "./address";
import { firstProp, readComponent, type Component, type ContentLine } from "./content-lines";

/** What one PUT may carry. Each override row is a statement of 3 rows (27 columns), and a request stays under 40 statements. */
export const MAX_VEVENTS = 40;
export const MAX_UID = 191;
const MAX_EXDATES = 1000;
const MAX_ATTENDEES = 100;
const MAX_TITLE = 500;
const MAX_LOCATION = 1000;
const MAX_DESCRIPTION = 20_000;
/** The calendar advertises 1900..2200 as its date range. */
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

/** The mapped columns of one VEVENT. A master also carries the repeat fields; an override row repeats `none`. */
export type EventFields = {
	title: string;
	description: string;
	location: string;
	attendees: string;
	attendeeResponses: string | null;
	startsAt: Date;
	endsAt: Date;
	allDay: boolean;
	timeZone: string | null;
	/** From the body; null when the body says nothing (the writer then keeps what an invitation set). */
	responseStatus: "cancelled" | "tentative" | "accepted" | "declined" | "needs-action" | null;
	inviteSender: string | null;
	/** CLASS:PRIVATE or CONFIDENTIAL (spec F9 D-6). */
	isPrivate: boolean;
	/** TRANSP:TRANSPARENT: shown as free. */
	transparent: boolean;
};
export type MasterFields = EventFields & { repeat: "none" | "daily" | "weekly" | "monthly" | "weekdays" | "custom"; repeatDays: string; repeatAnchorDay: number | null; repeatUntil: Date | null; rrule: string | null; excludedOccurrences: number[] };
export type OverrideFields = EventFields & { recurrenceId: Date };

export type ParsedCalendarObject = { uid: string; master: MasterFields; overrides: OverrideFields[] };
/** The DAV precondition (RFC 4791 section 5.3.2.1) a refused body violates. */
export type CalendarRefusal = "valid-calendar-object-resource" | "supported-calendar-component" | "max-instances";

const PARTSTATS: Record<string, "accepted" | "tentative" | "declined" | "needs-action"> = { ACCEPTED: "accepted", TENTATIVE: "tentative", DECLINED: "declined", "NEEDS-ACTION": "needs-action" };
const mailto = (value: string) => value.trim().replace(/^mailto:/i, "").toLowerCase();
const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);
const text = (event: Component, name: string) => unescapeText(firstProp(event, name)?.value ?? "").trim();
const inRange = (date: Date) => date.getUTCFullYear() >= MIN_YEAR && date.getUTCFullYear() <= MAX_YEAR;

/**
 * The columns one VEVENT maps to (spec 7.2), or null when its times cannot be read. Floating and all-day times are read in
 * `userZone`. `addresses` are the user's own, to tell their ATTENDEE line from the guests'.
 */
function mapEvent(event: Component, userZone: string, addresses: Set<string>): EventFields | null {
	const startProperty = firstProp(event, "DTSTART");
	const start = startProperty && parseIcsDate(startProperty, userZone);
	if (!start || !inRange(start.date)) return null;
	const endProperty = firstProp(event, "DTEND");
	const end = endProperty && parseIcsDate(endProperty, userZone);
	const duration = parseIcsDuration(firstProp(event, "DURATION")?.value);
	let endsAt: Date;
	if (end) endsAt = end.date;
	else if (duration) endsAt = new Date(addZonedDays(start.date, duration.days, start.zone).getTime() + duration.ms);
	else endsAt = start.allDay ? addZonedDays(start.date, 1, start.zone) : start.date;
	// An end before the start is a client bug; the event keeps its start and has no length.
	if (endsAt < start.date || !inRange(endsAt)) endsAt = start.allDay ? addZonedDays(start.date, 1, start.zone) : start.date;

	const organizer = mailto(firstProp(event, "ORGANIZER")?.value ?? "");
	const guests: string[] = [];
	const responses: Record<string, string> = {};
	let own: (typeof PARTSTATS)[string] | undefined;
	for (const property of event.props) {
		if (property.name !== "ATTENDEE" || guests.length >= MAX_ATTENDEES) continue;
		const address = mailto(property.value);
		if (!isDavAddress(address) || guests.includes(address)) continue;
		guests.push(address);
		const status = PARTSTATS[(property.params.PARTSTAT ?? "").toUpperCase()];
		if (status && status !== "needs-action") responses[address] = status;
		if (addresses.has(address)) own = status;
	}
	const external = organizer && isDavAddress(organizer) && !addresses.has(organizer);
	const status = (firstProp(event, "STATUS")?.value ?? "").trim().toUpperCase();
	const responseStatus = status === "CANCELLED" ? "cancelled" : external && own ? own : status === "TENTATIVE" ? "tentative" : null;
	return {
		title: clip(text(event, "SUMMARY"), MAX_TITLE) || "(no title)",
		description: clip(text(event, "DESCRIPTION"), MAX_DESCRIPTION),
		location: clip(text(event, "LOCATION"), MAX_LOCATION),
		attendees: JSON.stringify(guests),
		attendeeResponses: Object.keys(responses).length ? JSON.stringify(responses) : null,
		startsAt: start.date,
		endsAt,
		allDay: start.allDay,
		// A zone the client named; a floating, all-day or unknown-zone time was read in the user's, which is then the event's zone.
		timeZone: start.timeZone ?? (start.fallback ? start.zone : null),
		responseStatus,
		inviteSender: external ? organizer : null,
		isPrivate: ["PRIVATE", "CONFIDENTIAL"].includes(text(event, "CLASS").toUpperCase()),
		transparent: text(event, "TRANSP").toUpperCase() === "TRANSPARENT",
	};
}

/** The repeat columns for an RRULE value: legacy columns when they give exactly the same occurrences, else a custom rule, else (a rule the parser rejects) one occurrence with the rule kept in the body. */
function mapRepeat(rule: string | undefined, fields: EventFields): Pick<MasterFields, "repeat" | "repeatDays" | "repeatAnchorDay" | "repeatUntil" | "rrule"> {
	const none = { repeat: "none" as const, repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, rrule: null };
	const value = rule?.trim().replace(/^RRULE:/i, "");
	if (!value) return none;
	const zone = fields.timeZone ?? "UTC";
	const legacy = legacyRepeatFor(value, fields.startsAt, zone);
	// The columns hold whole seconds: an exclusive bound of "UNTIL plus 1 ms" must not be floored back onto the last occurrence.
	const until = legacy?.repeatUntil && new Date(Math.ceil(legacy.repeatUntil.getTime() / 1000) * 1000);
	if (legacy) return { repeat: legacy.repeat as MasterFields["repeat"], repeatDays: JSON.stringify(legacy.repeatDays), repeatAnchorDay: legacy.repeatAnchorDay, repeatUntil: until ?? null, rrule: null };
	if (parseRrule(value, zone)) return { repeat: "custom", repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, rrule: value };
	return none;
}

/** EXDATE instants, at most MAX_EXDATES of them (raw values are counted before any is parsed). */
function exdates(event: Component, userZone: string): number[] {
	const found = new Set<number>();
	let raw = 0;
	for (const property of event.props) {
		if (property.name !== "EXDATE") continue;
		for (const value of property.value.split(",", MAX_EXDATES - raw)) {
			raw++;
			const date = parseIcsDate({ ...property, value }, userZone);
			if (date) found.add(date.date.getTime());
		}
		if (raw >= MAX_EXDATES) break;
	}
	return [...found];
}

const refuse = (error: CalendarRefusal) => ({ error }) as const;

/**
 * An iCalendar PUT body as rows (spec 7.2): one master and its override rows. Pure and never throws. Refused (RFC 4791
 * preconditions): not a readable VCALENDAR, a METHOD, a component other than VEVENT and VTIMEZONE, more than MAX_VEVENTS
 * events, a missing, over-long or differing UID, an unreadable time, two overrides of one occurrence. ATTACH, URL and every
 * other property are only ever text here: nothing in the body is fetched. A VTIMEZONE is ignored; TZIDs resolve through
 * the Windows table and Intl. RRULE parts outside the supported subset leave a single occurrence (the body keeps the rule);
 * RDATE and VALARM stay in the body.
 */
export function parseCalendarObject(body: string, userZone: string | null | undefined, ownAddresses: string[]): ParsedCalendarObject | { error: CalendarRefusal } {
	const calendar = readComponent(body, "VCALENDAR");
	if (!calendar) return refuse("valid-calendar-object-resource");
	if (firstProp(calendar, "METHOD")) return refuse("valid-calendar-object-resource");
	const events: Component[] = [];
	for (const child of calendar.children) {
		if (child.name === "VEVENT") events.push(child);
		else if (child.name !== "VTIMEZONE") return refuse("supported-calendar-component");
	}
	if (!events.length) return refuse("valid-calendar-object-resource");
	if (events.length > MAX_VEVENTS) return refuse("max-instances");
	const uids = new Set(events.map((event) => firstProp(event, "UID")?.value.trim() ?? ""));
	const [uid] = [...uids];
	if (uids.size !== 1 || !uid || uid.length > MAX_UID || /[\u0000-\u001f\u007f]/.test(uid)) return refuse("valid-calendar-object-resource");

	const zone = normalizeTimeZone(userZone);
	const addresses = new Set(ownAddresses.map((address) => address.toLowerCase()));
	let master: MasterFields | null = null;
	const overrides: OverrideFields[] = [];
	const seen = new Set<number>();
	let masterEvent: Component | undefined;
	for (const event of events) {
		const fields = mapEvent(event, zone, addresses);
		if (!fields) return refuse("valid-calendar-object-resource");
		const recurrence: ContentLine | undefined = firstProp(event, "RECURRENCE-ID");
		if (!recurrence) {
			if (master) return refuse("valid-calendar-object-resource");
			masterEvent = event;
			master = { ...fields, ...mapRepeat(firstProp(event, "RRULE")?.value, fields), excludedOccurrences: [] };
			continue;
		}
		const at = parseIcsDate(recurrence, zone)?.date;
		if (!at || seen.has(at.getTime())) return refuse("valid-calendar-object-resource");
		seen.add(at.getTime());
		// A cancelled occurrence is only an exclusion: it has no row of its own.
		if (fields.responseStatus !== "cancelled") overrides.push({ ...fields, recurrenceId: at });
	}
	if (!master) {
		// A resource with only overrides (an invitation to one occurrence): the master is built from the first one and repeats `none`.
		const first = overrides.shift();
		if (!first) return refuse("valid-calendar-object-resource");
		return { uid, master: { ...first, repeat: "none", repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, rrule: null, excludedOccurrences: [] }, overrides };
	}
	// An override stands in for the instant it replaces, so the master skips it.
	master.excludedOccurrences = [...new Set([...(masterEvent ? exdates(masterEvent, zone) : []), ...seen])];
	return { uid, master, overrides };
}
