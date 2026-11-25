import { normalizeTimeZone, zonedDateFields } from "../time/utils";
import { isIcsAddress } from "./ics";
import type { ImportEvent, ImportGroup, ImportOptions, SplitIcsResult } from "./ics-import-types";
import { addZonedDays, inviteRepeat, parseIcsDate, parseIcsDuration, parseProperty, unescapeText, type InviteRepeat, type Property } from "./invite";
import { normalizeReminderMinutes } from "./reminder-utils";

/**
 * Reads whole iCalendar files (Google Takeout) for import. The file is attacker-controllable, so every step is
 * linear and bounded: lines are capped, components and properties are counted, and no regex runs on unbounded text.
 * Pure and framework-free, so the browser (preview, splitting) and the server (import) share it.
 */

/** A logical (unfolded) line longer than this is cut; the rest is dropped without being buffered. */
export const MAX_LINE_BYTES = 65_536;
const MAX_GROUP_EVENTS = 500;
const MAX_GROUP_BYTES = 512 * 1024;
export const MAX_IMPORT_EVENTS = 50_000;
const MAX_PROPERTIES = 2000;
const MAX_ALARMS = 20;
const MAX_EXDATES = 1000;
const MAX_ATTENDEES = 100;
const MAX_TITLE = 500;
const MAX_LOCATION = 500;
const MAX_DESCRIPTION = 8000;
const MAX_URL = 500;
const MAX_RRULE = 512;
const MAX_COUNT = 10_000;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const LINE_CONTROLS = /[\u0000-\u001f\u007f]+/g;
const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * Unfolds on bytes before decoding, so a fold inside a multi-byte character does not corrupt it. CRLF, LF and a
 * bare CR all end a line. Memory per line is bounded by `maxLine`. vCard files use the same folding.
 */
export function* iterIcsLines(bytes: Uint8Array, maxLine = MAX_LINE_BYTES): Generator<string> {
	const decoder = new TextDecoder();
	let pieces: Uint8Array[] = [];
	let size = 0;
	const flush = function* () {
		if (!pieces.length) return;
		let joined: Uint8Array;
		if (pieces.length === 1) joined = pieces[0];
		else {
			joined = new Uint8Array(size);
			let offset = 0;
			for (const piece of pieces) { joined.set(piece, offset); offset += piece.length; }
		}
		pieces = [];
		size = 0;
		if (joined.length) yield decoder.decode(joined);
	};
	let start = 0;
	const length = bytes.length;
	while (start <= length) {
		let end = start;
		while (end < length && bytes[end] !== 10 && bytes[end] !== 13) end++;
		if (end > start) {
			const folded = (bytes[start] === 32 || bytes[start] === 9) && pieces.length > 0;
			if (folded) start++;
			else yield* flush();
			const room = maxLine - size;
			if (room > 0 && end > start) {
				const piece = bytes.subarray(start, Math.min(end, start + room));
				pieces.push(piece);
				size += piece.length;
			}
		} else if (end < length) yield* flush();
		// CRLF is one terminator.
		start = end + (bytes[end] === 13 && bytes[end + 1] === 10 ? 2 : 1);
	}
	yield* flush();
}

export function readIcsLines(bytes: Uint8Array): string[] {
	return [...iterIcsLines(bytes)];
}

const beginName = (line: string) => (line.length > 6 && line.slice(0, 6).toUpperCase() === "BEGIN:" ? line.slice(6).trim().toUpperCase() : null);
const endName = (line: string) => (line.length > 4 && line.slice(0, 4).toUpperCase() === "END:" ? line.slice(4).trim().toUpperCase() : null);

/**
 * Splits a calendar file into the VEVENT blocks of each UID (everything else, such as VTIMEZONE, is dropped), so each
 * group can be sent to the server on its own. A UID with too many or too large events is left out and counted.
 */
export function splitIcsEvents(bytes: Uint8Array, limits: { maxEvents?: number; maxGroupEvents?: number; maxGroupBytes?: number } = {}): SplitIcsResult {
	const maxEvents = limits.maxEvents ?? MAX_IMPORT_EVENTS;
	const maxGroupEvents = limits.maxGroupEvents ?? MAX_GROUP_EVENTS;
	const maxGroupBytes = limits.maxGroupBytes ?? MAX_GROUP_BYTES;
	const groups = new Map<string, { lines: string[]; events: number; bytes: number; big: boolean }>();
	const result: SplitIcsResult = { groups: [], eventCount: 0, noUid: 0, tooBig: 0, truncated: false };
	let current: string[] | null = null;
	let currentBytes = 0;
	let nested = 0;
	let uid = "";
	for (const line of iterIcsLines(bytes)) {
		if (!current) {
			if (beginName(line) === "VEVENT") { current = [line]; currentBytes = line.length; nested = 0; uid = ""; }
			continue;
		}
		if (beginName(line) !== null) nested++;
		else if (endName(line) !== null) {
			if (nested > 0) nested--;
			else if (endName(line) === "VEVENT") {
				current.push(line);
				if (!uid || uid.length > 255) result.noUid++;
				else {
					if (result.eventCount >= maxEvents) { result.truncated = true; break; }
					result.eventCount++;
					let group = groups.get(uid);
					if (!group) groups.set(uid, group = { lines: [], events: 0, bytes: 0, big: false });
					if (!group.big) {
						group.events++;
						group.bytes += currentBytes;
						if (group.events > maxGroupEvents || group.bytes > maxGroupBytes) { group.big = true; group.lines = []; }
						else group.lines.push(...current);
					}
				}
				current = null;
				continue;
			}
		} else if (nested === 0 && !uid && /^UID[:;]/i.test(line.slice(0, 4))) {
			uid = parseProperty(line)?.value.trim() ?? "";
		}
		currentBytes += line.length + 1;
		if (currentBytes <= maxGroupBytes + MAX_LINE_BYTES) current.push(line);
	}
	for (const group of groups.values()) {
		if (group.big) result.tooBig++;
		else result.groups.push(group.lines.join("\n"));
	}
	return result;
}

type RawEvent = { props: Property[]; alarms: Property[][] };

/** The properties and VALARMs of each VEVENT. Deeper nesting is ignored; counts are capped. */
function readEvents(lines: string[]): RawEvent[] {
	const events: RawEvent[] = [];
	let current: RawEvent | null = null;
	let alarm: Property[] | null = null;
	let nested = 0;
	for (const line of lines) {
		const begin = beginName(line);
		const end = begin === null ? endName(line) : null;
		if (begin !== null) {
			if (!current) { if (begin === "VEVENT" && events.length < MAX_GROUP_EVENTS) { current = { props: [], alarms: [] }; nested = 0; } continue; }
			if (nested === 0 && begin === "VALARM" && current.alarms.length < MAX_ALARMS) alarm = [];
			nested++;
			continue;
		}
		if (end !== null) {
			if (!current) continue;
			if (nested > 0) {
				nested--;
				if (nested === 0 && alarm) { current.alarms.push(alarm); alarm = null; }
			} else if (end === "VEVENT") { events.push(current); current = null; }
			continue;
		}
		if (!current) continue;
		const property = parseProperty(line);
		if (!property) continue;
		if (nested === 0) { if (current.props.length < MAX_PROPERTIES) current.props.push(property); }
		else if (nested === 1 && alarm && alarm.length < 20) alarm.push(property);
	}
	return events;
}

const clean = (value: string) => value.replace(CONTROLS, "");
const oneLine = (value: string, max: number) => value.replace(LINE_CONTROLS, " ").trim().slice(0, max);
const BLOCK_TAG = /^\/?(?:br|p|div|li|tr|ul|ol|h[1-6])\b/i;

/** Plain text from the HTML Google puts in some descriptions: block tags become newlines, other tags vanish, five entities decode. */
export function icsHtmlToText(value: string): string {
	const text = value.slice(0, 20_000);
	let out = "";
	let index = 0;
	while (index < text.length) {
		const lt = text.indexOf("<", index);
		if (lt < 0) { out += text.slice(index); break; }
		out += text.slice(index, lt);
		const next = text.charCodeAt(lt + 1);
		const tagStart = (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 47 || next === 33;
		const gt = tagStart ? text.indexOf(">", lt + 1) : -1;
		if (gt < 0) {
			// Not a tag, or no closing bracket anywhere after: plain text.
			if (tagStart) { out += text.slice(lt); break; }
			out += "<";
			index = lt + 1;
			continue;
		}
		if (gt - lt <= 1000 && BLOCK_TAG.test(text.slice(lt + 1, gt))) out += "\n";
		index = gt + 1;
	}
	return out
		.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" })[name] as string)
		.replace(/\n{3,}/g, "\n\n");
}

function httpsUrl(value: string | undefined): string | null {
	const text = value?.trim();
	if (!text || text.length > MAX_URL) return null;
	try {
		const url = new URL(text);
		return url.protocol === "https:" && !/[\u0000- \u007f]/.test(url.href) ? url.href : null;
	} catch { return null; }
}

function addressOf(property: Property): string | null {
	const value = property.value.trim().replace(/^mailto:/i, "");
	if (!value || value.length > 254) return null;
	const address = value.toLowerCase();
	return isIcsAddress(address) ? address : null;
}

/** The smallest relative reminder before the start, from DISPLAY alarms first, else any alarm. */
function pickReminderMinutes(alarms: Property[][]): number | null {
	let display: number | null = null;
	let any: number | null = null;
	for (const alarm of alarms) {
		const trigger = alarm.find((property) => property.name === "TRIGGER");
		if (!trigger || (trigger.params.VALUE ?? "").toUpperCase() === "DATE-TIME" || (trigger.params.RELATED ?? "START").toUpperCase() !== "START") continue;
		const value = trigger.value.trim();
		if (!value.startsWith("-")) continue;
		const duration = parseIcsDuration(value.slice(1));
		if (!duration) continue;
		const minutes = normalizeReminderMinutes(Math.floor((duration.days * 86_400_000 + duration.ms) / 60_000));
		if (minutes === null) continue;
		any = any === null ? minutes : Math.min(any, minutes);
		if ((alarm.find((property) => property.name === "ACTION")?.value ?? "").trim().toUpperCase() === "DISPLAY") display = display === null ? minutes : Math.min(display, minutes);
	}
	return display ?? any;
}

/**
 * True when Mailflare's repeat model stores the rule exactly. inviteRepeat ignores parts it does not know (BYSETPOS,
 * BYMONTH, a negative BYMONTHDAY, the other weekday of a one-day rule), which would silently move occurrences, so such
 * rules are refused here and the series becomes a single event. So are a malformed UNTIL (it would make the series
 * endless), a COUNT that is not a positive whole number up to MAX_COUNT, and a monthly rule on the 29th to 31st:
 * Mailflare clamps those to the end of a short month while RFC 5545 and Google skip the month.
 */
function rruleIsRepresentable(rrule: string, start: Date, zone: string): boolean {
	if (rrule.length > MAX_RRULE) return false;
	const rule: Record<string, string> = {};
	for (const part of rrule.split(";")) {
		if (!part.trim()) continue;
		const eq = part.indexOf("=");
		if (eq < 1) return false;
		rule[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim().toUpperCase();
	}
	if (Object.keys(rule).some((key) => !["FREQ", "UNTIL", "COUNT", "INTERVAL", "BYDAY", "BYMONTHDAY", "WKST"].includes(key))) return false;
	if (rule.INTERVAL && rule.INTERVAL !== "1") return false;
	if (rule.UNTIL !== undefined && !parseIcsDate({ name: "UNTIL", params: {}, value: rule.UNTIL }, zone)) return false;
	if (rule.COUNT !== undefined && !(/^\d{1,5}$/.test(rule.COUNT) && Number(rule.COUNT) >= 1 && Number(rule.COUNT) <= MAX_COUNT)) return false;
	const fields = zonedDateFields(start, zone);
	if (rule.FREQ === "MONTHLY") {
		if (rule.BYDAY || fields.getUTCDate() > 28) return false;
		return rule.BYMONTHDAY === undefined || (/^\d{1,2}$/.test(rule.BYMONTHDAY) && Number(rule.BYMONTHDAY) === fields.getUTCDate());
	}
	if (rule.FREQ !== "DAILY" && rule.FREQ !== "WEEKLY") return false;
	if (rule.BYMONTHDAY !== undefined) return false;
	if (rule.BYDAY === undefined) return true;
	const days = rule.BYDAY.split(",");
	if (days.length > 7 || days.some((day) => !WEEKDAY_CODES.includes(day))) return false;
	return days.includes(WEEKDAY_CODES[fields.getUTCDay()]);
}

type Outcome =
	| { kind: "event"; event: ImportEvent; simplified: boolean; guessed: boolean }
	| { kind: "cancelled-occurrence"; occurrence: Date }
	| { kind: "skipped"; occurrence?: Date }
	| { kind: "failed"; reason: string; occurrence?: Date };

const NO_REPEAT: InviteRepeat = { repeat: "none", repeatDays: [], repeatAnchorDay: null, repeatUntil: null, repeatInterval: 1, repeatWeekday: null, repeatWeek: null };

function readEvent(raw: RawEvent, options: ImportOptions, own: Set<string>): Outcome {
	const { props, alarms } = raw;
	const find = (name: string) => props.find((property) => property.name === name);
	const zoneOf = options.userZone;
	const cancelled = (find("STATUS")?.value ?? "").trim().toUpperCase() === "CANCELLED";
	const recurrenceProperty = find("RECURRENCE-ID");
	const recurrence = recurrenceProperty ? parseIcsDate(recurrenceProperty, zoneOf) : null;
	if (recurrenceProperty && !recurrence) return { kind: "failed", reason: "unreadable occurrence id" };
	if (cancelled) return recurrence ? { kind: "cancelled-occurrence", occurrence: recurrence.date } : { kind: "skipped" };
	const startProperty = find("DTSTART");
	const start = startProperty ? parseIcsDate(startProperty, zoneOf) : null;
	if (!start) return { kind: "failed", reason: "no readable start time", occurrence: recurrence?.date };

	const attendees = new Set<string>();
	let declined = false;
	for (const property of props) {
		if (property.name !== "ATTENDEE") continue;
		const address = addressOf(property);
		if (!address) continue;
		if (own.has(address)) { if ((property.params.PARTSTAT ?? "").toUpperCase() === "DECLINED") declined = true; }
		else if (attendees.size < MAX_ATTENDEES) attendees.add(address);
	}
	if (declined && options.skipDeclined) return { kind: "skipped", occurrence: recurrence?.date };

	const endProperty = find("DTEND");
	const end = endProperty ? parseIcsDate(endProperty, zoneOf) : null;
	const duration = parseIcsDuration(find("DURATION")?.value);
	const startsAt = start.date;
	const fallbackEnd = () => start.allDay ? addZonedDays(startsAt, 1, start.zone) : new Date(startsAt.getTime() + 3_600_000);
	let endsAt = end ? end.date : duration ? new Date(addZonedDays(startsAt, duration.days, start.zone).getTime() + duration.ms) : fallbackEnd();
	if (endsAt <= startsAt) endsAt = fallbackEnd();
	if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) return { kind: "failed", reason: "invalid dates", occurrence: recurrence?.date };
	let timeZone = start.timeZone ?? zoneOf;
	const guessed = (!start.allDay && start.fallback) || (!!end && !end.allDay && end.fallback);

	let repeat = NO_REPEAT;
	let simplified = false;
	let excluded: Date[] = [];
	if (!recurrence) {
		const rrule = find("RRULE")?.value.trim();
		if (rrule && rruleIsRepresentable(rrule, startsAt, start.zone)) repeat = inviteRepeat(rrule, startsAt, start.zone);
		simplified = (!!rrule && repeat.repeat === "none") || props.some((property) => property.name === "RDATE");
		if (repeat.repeat !== "none") {
			// A UTC start has no zone of its own. The calendar expands a series on the wall clock of the stored zone, so
			// read in the user's zone it would drift by an hour after a DST change and the weekdays (and EXDATEs) written
			// in UTC would no longer match.
			if (start.zone === "UTC" && !start.fallback) timeZone = "UTC";
			const values: { property: Property; value: string }[] = [];
			for (const property of props) {
				if (property.name !== "EXDATE") continue;
				for (const value of property.value.split(",", MAX_EXDATES - values.length)) values.push({ property, value });
				if (values.length >= MAX_EXDATES) break;
			}
			excluded = values.flatMap(({ property, value }) => parseIcsDate({ ...property, value }, zoneOf)?.date ?? []);
		}
	}

	const extras: string[] = [];
	let location = oneLine(unescapeText(find("LOCATION")?.value ?? ""), MAX_LOCATION);
	let base = unescapeText(find("DESCRIPTION")?.value ?? "").slice(0, 20_000);
	let joinUrl = httpsUrl(find("X-GOOGLE-CONFERENCE")?.value);
	// Google appends a "-::~:~::~:" block with its join details to the description; keep only the https link.
	const block = base.indexOf("-::~:~::~:");
	if (block >= 0) {
		joinUrl ??= httpsUrl(/https:\/\/[^\s<>"]{1,500}/.exec(base.slice(block))?.[0]);
		base = base.slice(0, block);
	}
	if (/<\/?(?:br|p|a|div|b|i|ul|ol|li|span|h[1-6])\b/i.test(base)) base = icsHtmlToText(base);
	base = clean(base).trim().slice(0, MAX_DESCRIPTION);
	const organizer = find("ORGANIZER");
	const organizerAddress = organizer ? addressOf(organizer) : null;
	if (organizer && organizerAddress && !own.has(organizerAddress)) {
		const name = oneLine((organizer.params.CN ?? "").replace(/[<>]/g, ""), 100);
		extras.push(name ? `Organizer: ${name} <${organizerAddress}>` : `Organizer: ${organizerAddress}`);
	}
	if (joinUrl) {
		extras.push(`Join: ${joinUrl}`);
		if (!location) location = joinUrl;
	}
	const url = httpsUrl(find("URL")?.value);
	if (url && url !== joinUrl) extras.push(url);
	const description = [base, extras.join("\n")].filter(Boolean).join("\n\n");

	return {
		kind: "event", simplified, guessed,
		event: {
			title: oneLine(unescapeText(find("SUMMARY")?.value ?? ""), MAX_TITLE) || "(no title)",
			description, location, startsAt, endsAt, timeZone,
			repeat: repeat.repeat, repeatDays: repeat.repeatDays, repeatAnchorDay: repeat.repeatAnchorDay, repeatUntil: repeat.repeatUntil,
			excluded, reminderMinutes: options.reminders ? pickReminderMinutes(alarms) : null,
			attendees: [...attendees], recurrenceId: recurrence?.date ?? null,
		},
	};
}

/**
 * Reads the VEVENTs of one UID: the series (no RECURRENCE-ID) plus its changed occurrences. Never throws; what cannot
 * be read lands in `failures`.
 */
export function parseIcsEventGroup(text: string, options: ImportOptions): ImportGroup {
	const group: ImportGroup = { uid: "", master: null, overrides: [], simplified: false, guessedZone: false, skipped: 0, failures: [] };
	try {
		const opts = { ...options, userZone: normalizeTimeZone(options.userZone) };
		const own = new Set(options.ownAddresses);
		const events = readEvents(readIcsLines(new TextEncoder().encode(text)));
		const cancelled: Date[] = [];
		for (const raw of events) {
			const uid = raw.props.find((property) => property.name === "UID")?.value.trim() ?? "";
			if (!group.uid) group.uid = uid.slice(0, 255);
			const outcome = readEvent(raw, opts, own);
			if ((outcome.kind === "failed" || outcome.kind === "skipped") && outcome.occurrence) cancelled.push(outcome.occurrence);
			if (outcome.kind === "failed") {
				group.failures.push(`${oneLine(unescapeText(raw.props.find((property) => property.name === "SUMMARY")?.value ?? ""), 80) || uid.slice(0, 80) || "(event)"}: ${outcome.reason}`);
			} else if (outcome.kind === "skipped") group.skipped++;
			else if (outcome.kind === "cancelled-occurrence") cancelled.push(outcome.occurrence);
			else if (outcome.event.recurrenceId) {
				group.overrides.push(outcome.event);
				group.guessedZone ||= outcome.guessed;
			} else if (!group.master) {
				group.master = outcome.event;
				group.simplified = outcome.simplified;
				group.guessedZone ||= outcome.guessed;
			}
		}
		const master = group.master;
		if (master) {
			if (master.repeat === "none") {
				// An override on the one date a single event has replaces it.
				if (group.overrides.some((override) => override.recurrenceId!.getTime() === master.startsAt.getTime())) group.master = null;
			} else {
				const all = new Map<number, Date>();
				for (const date of [...master.excluded, ...cancelled, ...group.overrides.map((override) => override.recurrenceId!)]) all.set(date.getTime(), date);
				// Bounded already: at most MAX_EXDATES EXDATE values plus one date per event of the group (MAX_GROUP_EVENTS), so
				// under 22 KB as JSON. Nothing is cut here: a dropped exclusion would resurrect a deleted occurrence.
				master.excluded = [...all.values()].sort((a, b) => a.getTime() - b.getTime());
			}
		}
	} catch {
		group.failures.push("(event): unreadable");
	}
	return group;
}
