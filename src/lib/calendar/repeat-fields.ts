import { dateFromZonedFields, normalizeTimeZone, zonedDateFields } from "@/lib/time/utils";
import { DEFAULT_REPEAT_DAYS, normalizeCalendarRepeat, normalizeCalendarRepeatDays, parseCalendarRepeatDays, parseExcludedOccurrences } from "./recurrence";
import type { CalendarRepeat } from "./types";

/**
 * A calendar row keeps its repeat in two forms: the repeat_* columns for what Mailflare's editor can express, and `rrule`
 * for anything else. The invariant every writer must keep: `repeat = "custom"` exactly when `rrule` is set, and a custom
 * row has no legacy columns (its end lives in the rule's UNTIL). The helpers below are the only place the update paths
 * decide this.
 */
type RepeatRow = { repeat: string; rrule?: string | null; repeatDays: string; repeatAnchorDay: number | null; repeatUntil: Date | null };
export type RepeatFields = { repeat: CalendarRepeat; repeatDays: string; repeatAnchorDay: number | null; repeatUntil: Date | null; rrule: string | null };

export function isConsistentRepeat(row: RepeatRow): boolean {
	if ((row.repeat === "custom") !== Boolean(row.rrule)) return false;
	return row.repeat !== "custom" || (row.repeatDays === "[]" && row.repeatAnchorDay === null && row.repeatUntil === null);
}

/** An update keeps a custom rule when the row has one and the caller did not choose a different repeat. */
export function keepsCustomRepeat(existing: { rrule?: string | null } | null, requested?: string): boolean {
	return Boolean(existing?.rrule) && (requested === undefined || requested === "custom");
}

/** The zone an edit saves: a kept custom rule stays in the zone it was saved in (the editor's own zone would move every occurrence), anything else takes the requested zone. */
export function editedTimeZone(existing: { rrule?: string | null; timeZone?: string | null }, requestedRepeat: string | undefined, requestedZone: string | null | undefined): string {
	return normalizeTimeZone(keepsCustomRepeat(existing, requestedRepeat) ? existing.timeZone : requestedZone ?? existing.timeZone);
}

/**
 * The repeat columns after a create (`existing` null) or a web/API edit. Returns null when "weekdays" has no day.
 * A client can never send "custom": only an existing rule can be kept.
 */
export function resolveRepeat(existing: RepeatRow | null, input: { repeat?: string; repeatDays?: number[]; repeatAnchorDay?: number }): RepeatFields | null {
	if (existing && keepsCustomRepeat(existing, input.repeat)) return { repeat: "custom", repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, rrule: existing.rrule! };
	// "custom" with no rule to keep is no request at all: the row keeps the repeat it has.
	const repeat = normalizeCalendarRepeat((input.repeat === "custom" ? undefined : input.repeat) ?? existing?.repeat);
	const previousDays = existing?.repeat === "weekdays" ? parseCalendarRepeatDays(existing.repeatDays) : DEFAULT_REPEAT_DAYS;
	const repeatDays = repeat === "weekdays" ? normalizeCalendarRepeatDays(input.repeatDays ?? previousDays) : [];
	if (repeat === "weekdays" && repeatDays.length === 0) return null;
	const validAnchor = Number.isInteger(input.repeatAnchorDay) && input.repeatAnchorDay! >= 1 && input.repeatAnchorDay! <= 31;
	return {
		repeat, repeatDays: JSON.stringify(repeatDays),
		repeatAnchorDay: repeat === "monthly" ? (validAnchor ? input.repeatAnchorDay! : existing?.repeatAnchorDay ?? null) : null,
		repeatUntil: repeat === "none" ? null : existing?.repeatUntil ?? null,
		rrule: null,
	};
}

/** The same decision for the MCP update tool, which derives a monthly anchor from the start and never touches repeat_until. */
export function repeatForToolUpdate(row: RepeatRow, item: { repeat?: string; repeatDays?: number[] }, startsAt: Date, timeZone: string): Omit<RepeatFields, "repeatUntil"> {
	if (keepsCustomRepeat(row, item.repeat)) return { repeat: "custom", repeatDays: "[]", repeatAnchorDay: null, rrule: row.rrule! };
	const repeat = normalizeCalendarRepeat((item.repeat === "custom" ? undefined : item.repeat) ?? row.repeat);
	const zone = normalizeTimeZone(timeZone);
	// A weekdays repeat with no day to go on (a custom or one-off row switched to it) repeats on the start's weekday, never on no day at all.
	const days = normalizeCalendarRepeatDays(item.repeatDays ?? parseCalendarRepeatDays(row.repeatDays));
	return {
		repeat,
		repeatDays: repeat === "weekdays" ? JSON.stringify(days.length ? days : [zonedDateFields(startsAt, zone).getUTCDay()]) : item.repeatDays ? JSON.stringify(normalizeCalendarRepeatDays(item.repeatDays)) : row.repeatDays,
		repeatAnchorDay: repeat === "monthly" ? zonedDateFields(startsAt, zone).getUTCDate() : null,
		rrule: null,
	};
}

/** repeat_until after "delete this and following" from `cut`: the earlier of the existing end and the cut, so a series that already ended is never extended. */
export function endLegacySeries(repeatUntil: Date | null, cut: Date): Date {
	return repeatUntil && repeatUntil < cut ? repeatUntil : cut;
}

/** Shown when an edit would move a custom series to another day; the API answers 409 with it and the calendar shows it. */
export const CUSTOM_DAY_LOCKED = "This repeat was set in another app; change the day there";

const DAY = 86_400_000;

/** True when both instants are on the same calendar day in `zone`. */
export function sameZonedDay(a: Date, b: Date, zone: string | null | undefined): boolean {
	const timeZone = normalizeTimeZone(zone);
	return Math.floor(zonedDateFields(a, timeZone).getTime() / DAY) === Math.floor(zonedDateFields(b, timeZone).getTime() / DAY);
}

/**
 * A custom rule is not editable here, so a custom series may only change time of day. Returns null when `startsAt` is on
 * another calendar day than the series start (in `timeZone`); otherwise how the series' own instants move with it:
 * `exclude` is the exclusion list and `shift` maps an override's recurrence_id, both by the same wall-clock delta, so a
 * skipped or moved occurrence still points at the occurrence it meant.
 */
export function shiftCustomSeries(existing: { startsAt: Date; excludedOccurrences: string }, startsAt: Date, timeZone: string | null | undefined): { excludedOccurrences: string; shift: (at: Date) => Date; moved: boolean } | null {
	const zone = normalizeTimeZone(timeZone);
	if (!sameZonedDay(existing.startsAt, startsAt, zone)) return null;
	const delta = zonedDateFields(startsAt, zone).getTime() - zonedDateFields(existing.startsAt, zone).getTime();
	const shift = (at: Date) => (delta === 0 ? at : dateFromZonedFields(new Date(zonedDateFields(at, zone).getTime() + delta), zone));
	return { excludedOccurrences: JSON.stringify(parseExcludedOccurrences(existing.excludedOccurrences).map((at) => shift(new Date(at)).getTime())), shift, moved: delta !== 0 };
}
