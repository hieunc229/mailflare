import { buildVevent, validTimeZone, type FeedEvent } from "@/lib/calendar/feed";
import { escapeIcsText, formatIcsUtc, joinIcsLines } from "@/lib/calendar/ics";
import { parseIcsDate, parseProperty } from "@/lib/calendar/invite";
import { buildVtimezone } from "@/lib/calendar/vtimezone";
import { parseExcludedOccurrences } from "@/lib/calendar/recurrence";
import type { CalendarResource, EventRow } from "./calendar-render";
import { firstProp, readComponent, type Component } from "./content-lines";

/** A row as the VEVENT builder reads it; `excluded` instants are left out of the exclusions (an override row stands in for them). */
export const feedRow = (row: EventRow, excluded?: Set<number>): FeedEvent => ({
	...row,
	repeat: row.repeat,
	excludedOccurrences: excluded ? JSON.stringify(parseExcludedOccurrences(row.excludedOccurrences).filter((at) => !excluded.has(at))) : row.excludedOccurrences,
});

const seconds = (date: Date | null) => (date ? Math.floor(date.getTime() / 1000) : null);

/**
 * The row fields a DAV body is generated from, in one canonical form (timestamps in whole seconds, as the database keeps them). The two
 * flags (CLASS, TRANSP) are added only when set, so the hash of an event that has neither is what it was before they were mapped and no
 * stored body of an ordinary event is treated as edited.
 */
const project = (row: EventRow) => [row.title, row.description, row.location, row.attendees, row.attendeeResponses ?? "", row.repeat, row.rrule ?? "", row.repeatDays, row.repeatAnchorDay, seconds(row.repeatUntil), row.excludedOccurrences, row.timeZone ?? "", seconds(row.startsAt), seconds(row.endsAt), row.allDay, row.reminderMinutes ?? null, row.responseStatus ?? "", seconds(row.recurrenceId), ...(row.isPrivate ? ["private"] : []), ...(row.transparent ? ["free"] : [])];

/**
 * SHA-256 of the projected fields of a resource's rows. Stored beside the body a client PUT: while the rows still hash to
 * the same value the body is exactly what the client sent, so it is served byte for byte; once a Mailflare-side edit
 * changes a field, the next read merges that edit into the body (mergeCalendarBody).
 */
export async function rowsHash(master: EventRow, overrides: EventRow[]): Promise<string> {
	const ordered = [...overrides].sort((a, b) => (seconds(a.recurrenceId) ?? 0) - (seconds(b.recurrenceId) ?? 0));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([project(master), ...ordered.map(project)])));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The properties the rows own. Everything else a client sent is kept as it was. */
const MAPPED = new Set(["UID", "DTSTAMP", "LAST-MODIFIED", "SEQUENCE", "SUMMARY", "DESCRIPTION", "LOCATION", "DTSTART", "DTEND", "DURATION", "RRULE", "EXDATE", "STATUS", "ATTENDEE", "CLASS", "TRANSP"]);

const serialize = (component: Component): string[] => [`BEGIN:${component.name}`, ...component.props.map((property) => property.raw), ...component.children.flatMap(serialize), `END:${component.name}`];
const nameOf = (line: string) => parseProperty(line)?.name ?? "";
const mailto = (value: string) => value.trim().replace(/^mailto:/i, "").toLowerCase();
const quote = (value: string) => (/[;:,]/.test(value) ? `"${value}"` : value);

function parseJson<T>(value: string | null, fallback: T): T {
	try {
		return (JSON.parse(value ?? "") as T) ?? fallback;
	} catch {
		return fallback;
	}
}

/** The ATTENDEE lines for a row: a line the client wrote is kept (its PARTSTAT follows the row), a new guest gets a plain one. */
function attendeeLines(row: EventRow, stored: Component | undefined): string[] {
	const guests = parseJson<string[]>(row.attendees, []);
	const responses = parseJson<Record<string, string>>(row.attendeeResponses, {});
	const known = new Map((stored?.props ?? []).filter((property) => property.name === "ATTENDEE").map((property) => [mailto(property.value), property]));
	return guests.map((address) => {
		const status = responses[address]?.toUpperCase();
		const old = known.get(address);
		if (!old) return `ATTENDEE;PARTSTAT=${status ?? "NEEDS-ACTION"}:mailto:${address}`;
		if (!status || (old.params.PARTSTAT ?? "").toUpperCase() === status) return old.raw;
		const params = Object.entries({ ...old.params, PARTSTAT: status }).map(([key, value]) => `;${key}=${quote(value)}`).join("");
		return `ATTENDEE${params}:${old.value}`;
	});
}

/** One VEVENT: the client's lines for what the rows do not own, then the rows' own properties. */
function mergeEvent(row: EventRow, resource: CalendarResource, stored: Component | undefined, recurrenceId: Date | undefined, userZone: string | null | undefined, extra: { sequence: number; alarm: boolean; overridden?: Set<number> }): string[] {
	const generated = buildVevent(feedRow(row, extra.overridden), { stamp: formatIcsUtc(row.updatedAt), recurrenceId, uid: resource.uid, fallbackZone: userZone });
	// A rule the rows cannot hold (repeat `none`, but the client sent an RRULE) stays exactly as the client wrote it, with its exclusions.
	const keepRule = row.repeat === "none" && !recurrenceId && !!stored && !!firstProp(stored, "RRULE");
	const own = generated.slice(1, -1).filter((line) => {
		const name = nameOf(line);
		return MAPPED.has(name) && name !== "UID" && !(keepRule && name === "EXDATE");
	});
	const keptRecurrence = stored && firstProp(stored, "RECURRENCE-ID") ? [] : generated.filter((line) => nameOf(line) === "RECURRENCE-ID");
	const lines = ["BEGIN:VEVENT", stored && firstProp(stored, "UID")?.raw || `UID:${resource.uid}`, ...keptRecurrence];
	for (const property of stored?.props ?? []) if (!MAPPED.has(property.name) || (keepRule && (property.name === "RRULE" || property.name === "EXDATE"))) lines.push(property.raw);
	lines.push(...own, ...attendeeLines(row, stored), `SEQUENCE:${extra.sequence}`);
	const alarms = stored?.children.map((child) => ({ ...child })) ?? [];
	// A reminder set in Mailflare is the first alarm's trigger; without one the client's alarms are left alone.
	if (extra.alarm && row.reminderMinutes !== null) {
		const trigger = `TRIGGER:${row.reminderMinutes ? `-PT${row.reminderMinutes}M` : "PT0S"}`;
		const first = alarms.findIndex((child) => child.name === "VALARM");
		if (first >= 0) alarms[first] = { ...alarms[first], props: [...alarms[first].props.filter((property) => property.name !== "TRIGGER").map((property) => ({ ...property })), { name: "TRIGGER", params: {}, value: trigger.slice(8), raw: trigger }] };
		else alarms.push({ name: "VALARM", children: [], props: ["ACTION:DISPLAY", `DESCRIPTION:${escapeIcsText(row.title)}`, trigger].map((raw) => ({ ...parseProperty(raw)!, raw })) });
	}
	for (const child of alarms) lines.push(...serialize(child));
	lines.push("END:VEVENT");
	return lines;
}

/**
 * The stored body of a DAV event after a Mailflare-side edit (spec 7.3, second case): the client's own lines are kept, the
 * properties the rows own (summary, description, location, start, end, repeat, exclusions, guests, status) are rewritten
 * from the rows, SEQUENCE goes up by one and LAST-MODIFIED and DTSTAMP are the rows' update time. Override VEVENTs are rebuilt
 * from the override rows, keeping the client's other lines for the same RECURRENCE-ID; overrides whose rows are gone are
 * dropped; a zone the rows now use gets its VTIMEZONE. A first reminder set in Mailflare becomes the first alarm's trigger.
 * Null when the stored text cannot be read, so the caller generates the body from the rows instead.
 */
export function mergeCalendarBody(storedBody: string, resource: CalendarResource, userZone?: string | null): string | null {
	try {
		return mergeBody(storedBody, resource, userZone);
	} catch (error) {
		// Whatever the client's text holds, a read must still answer: the caller generates the body from the rows.
		if (!warned) {
			warned = true;
			console.warn("DAV: a stored calendar body could not be merged; serving the generated body", error);
		}
		return null;
	}
}

let warned = false;

function mergeBody(storedBody: string, resource: CalendarResource, userZone?: string | null): string | null {
	const calendar = readComponent(storedBody, "VCALENDAR");
	if (!calendar) return null;
	const events = calendar.children.filter((child) => child.name === "VEVENT");
	const zone = userZone ?? "UTC";
	const recurrenceOf = (event: Component) => {
		const property = firstProp(event, "RECURRENCE-ID");
		return property ? parseIcsDate(property, zone)?.date.getTime() : undefined;
	};
	const storedMaster = events.find((event) => !firstProp(event, "RECURRENCE-ID")) ?? events[0];
	const storedOverrides = new Map(events.filter((event) => event !== storedMaster).flatMap((event) => (recurrenceOf(event) === undefined ? [] : [[recurrenceOf(event)!, event] as const])));
	const sequenceOf = (event: Component | undefined) => (Number.parseInt(firstProp(event ?? { name: "", props: [], children: [] }, "SEQUENCE")?.value ?? "", 10) || 0) + 1;

	const eventLines = [
		...mergeEvent(resource.master, resource, storedMaster, undefined, userZone, { sequence: sequenceOf(storedMaster), alarm: true, overridden: new Set(resource.overrides.flatMap((row) => (row.recurrenceId ? [row.recurrenceId.getTime()] : []))) }),
		...resource.overrides.flatMap((row) => {
			const at = row.recurrenceId ?? undefined;
			const old = at && storedOverrides.get(at.getTime());
			return mergeEvent(row, resource, old || undefined, at, userZone, { sequence: sequenceOf(old || undefined), alarm: false });
		}),
	];
	const zones = new Map(calendar.children.filter((child) => child.name === "VTIMEZONE").map((child) => [firstProp(child, "TZID")?.value.trim() ?? "", child] as const));
	const needed = new Set<string>();
	for (const line of eventLines) {
		const property = parseProperty(line);
		const tzid = property?.params.TZID;
		if (tzid && !zones.has(tzid) && validTimeZone(tzid)) needed.add(tzid);
	}
	const lines = ["BEGIN:VCALENDAR", ...calendar.props.map((property) => property.raw)];
	for (const child of zones.values()) lines.push(...serialize(child));
	for (const tzid of needed) lines.push(...buildVtimezone(tzid, resource.master.startsAt.getUTCFullYear()));
	lines.push(...eventLines, "END:VCALENDAR");
	return joinIcsLines(lines);
}
