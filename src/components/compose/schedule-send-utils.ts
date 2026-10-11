import type { ScheduleSendOption } from "./schedule-send-types";
import { dateFromZonedFields, formatUserDate, formatUserDateTimeLocal, getUserTimeZone, parseUserDateTimeLocal, zonedDateFields } from "@/lib/time/utils";

function atTime(date: Date, hours: number): Date {
	const fields = new Date(date);
	fields.setUTCHours(hours, 0, 0, 0);
	return dateFromZonedFields(fields, getUserTimeZone());
}

export function getScheduleSendOptions(now = new Date()): ScheduleSendOption[] {
	const laterToday = new Date(now.getTime() + 3 * 60 * 60 * 1000);
	const today = zonedDateFields(now, getUserTimeZone());
	const tomorrow = new Date(today);
	tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
	const monday = new Date(today);
	const daysUntilMonday = ((8 - monday.getUTCDay()) % 7) || 7;
	monday.setUTCDate(monday.getUTCDate() + daysUntilMonday);

	return [
		{ labelKey: zonedDateFields(laterToday, getUserTimeZone()).toISOString().slice(0, 10) === today.toISOString().slice(0, 10) ? "schedule.laterToday" : "schedule.in3Hours", value: laterToday },
		{ labelKey: "schedule.tomorrowMorning", value: atTime(tomorrow, 8) },
		{ labelKey: "schedule.mondayMorning", value: atTime(monday, 8) },
	];
}

export type ScheduleQuickOption = { id: "tomorrowMorning" | "tomorrowAfternoon" | "mondayMorning"; value: Date };

/** Gmail's three quick picks: tomorrow at 8 AM and 1 PM, and the next Monday at 8 AM
 * (the Monday after, when tomorrow already is Monday). */
export function getQuickScheduleOptions(now = new Date()): ScheduleQuickOption[] {
	const today = zonedDateFields(now, getUserTimeZone());
	const tomorrow = new Date(today);
	tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
	const monday = new Date(today);
	monday.setUTCDate(monday.getUTCDate() + (((8 - monday.getUTCDay()) % 7) || 7));
	if (monday.toISOString().slice(0, 10) === tomorrow.toISOString().slice(0, 10)) monday.setUTCDate(monday.getUTCDate() + 7);
	return [
		{ id: "tomorrowMorning", value: atTime(tomorrow, 8) },
		{ id: "tomorrowAfternoon", value: atTime(tomorrow, 13) },
		{ id: "mondayMorning", value: atTime(monday, 8) },
	];
}

/** "Oct 11" and "8:00 AM", joined by the caller's translation ("Oct 11 at 8:00 AM"). */
export function formatQuickScheduleParts(value: Date): { date: string; time: string } {
	return {
		date: formatUserDate(value, { month: "short", day: "numeric" }),
		time: formatUserDate(value, { hour: "numeric", minute: "2-digit" }),
	};
}

/** The long name of the user's time zone right now, e.g. "Pacific Daylight Time". */
export function getTimeZoneLongName(now = new Date()): string {
	const zone = getUserTimeZone();
	try {
		const part = new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: "long" }).formatToParts(now).find((p) => p.type === "timeZoneName");
		return part?.value ?? zone;
	} catch {
		return zone;
	}
}

/** Earliest value for the date-time picker: five minutes from now, in the user's zone. */
export function getMinimumScheduleLocal(now = new Date()): string {
	return formatDateTimeLocal(new Date(now.getTime() + 5 * 60 * 1000));
}

export function isSchedulableTime(value: Date, now = new Date()): boolean {
	return value.getTime() > now.getTime() + 60 * 1000;
}

export function formatScheduledSend(value: Date): string {
	return formatUserDate(value, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function formatDateTimeLocal(value: Date): string {
	return formatUserDateTimeLocal(value);
}

export function parseDateTimeLocal(value: string): Date | null {
	return parseUserDateTimeLocal(value);
}
