import type { ZonedDay } from "./types";

const fieldFormatters = new Map<string, Intl.DateTimeFormat>();
const displayFormatters = new Map<string, Intl.DateTimeFormat>();
const normalizedTimeZones = new Map<string, string>();
let resolvedUserTimeZone: string | undefined;

function getFieldFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = fieldFormatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone, year: "numeric", month: "2-digit", day: "2-digit",
			hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
		});
		if (fieldFormatters.size >= 64) fieldFormatters.clear();
		fieldFormatters.set(timeZone, formatter);
	}
	return formatter;
}

function getDisplayFormatter(locale: string | undefined, options: Intl.DateTimeFormatOptions, timeZone: string): Intl.DateTimeFormat {
	const key = `${locale ?? "default"}\u0000${timeZone}\u0000${JSON.stringify(options)}`;
	let formatter = displayFormatters.get(key);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone });
		if (displayFormatters.size >= 64) displayFormatters.clear();
		displayFormatters.set(key, formatter);
	}
	return formatter;
}

export function normalizeTimeZone(value?: string | null): string {
	const key = value || "UTC";
	let normalized = normalizedTimeZones.get(key);
	if (!normalized) {
		try {
			normalized = new Intl.DateTimeFormat("en-US", { timeZone: key }).resolvedOptions().timeZone;
		} catch {
			normalized = "UTC";
		}
		if (normalizedTimeZones.size >= 64) normalizedTimeZones.clear();
		normalizedTimeZones.set(key, normalized);
	}
	return normalized;
}

export function isValidTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

export function getUserTimeZone(): string {
	if (typeof window === "undefined") return "UTC";
	if (resolvedUserTimeZone) return resolvedUserTimeZone;
	let zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	try {
		const saved = JSON.parse(window.localStorage.getItem("mailflare-user-time-zone") ?? "null") as { timeZone?: unknown } | null;
		if (typeof saved?.timeZone === "string" && isValidTimeZone(saved.timeZone)) zone = normalizeTimeZone(saved.timeZone);
	} catch { /* Device time remains available without storage. */ }
	resolvedUserTimeZone = zone;
	return zone;
}

export function clearUserTimeZoneCache(): void {
	resolvedUserTimeZone = undefined;
}

export function getRequestTimeZone(request: Request, preferredTimeZone?: string | null): string {
	return normalizeTimeZone(preferredTimeZone ?? new URL(request.url).searchParams.get("timeZone") ?? request.headers.get("X-Time-Zone"));
}

/** The interface language the language provider keeps on `<html lang>`; the browser default when unset or on the server. */
export function getDisplayLocale(): string | undefined {
	if (typeof document === "undefined") return undefined;
	return document.documentElement.lang || undefined;
}

export function formatUserDate(value: Date | string, options: Intl.DateTimeFormatOptions): string {
	return getDisplayFormatter(getDisplayLocale(), options, getUserTimeZone()).format(new Date(value));
}

export function formatUserDateTimeLocal(value: Date): string {
	return zonedDateFields(value, getUserTimeZone()).toISOString().slice(0, 16);
}

export function parseUserDateTimeLocal(value: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
	if (!match) return null;
	const fields = new Date(0);
	fields.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	fields.setUTCHours(Number(match[4]), Number(match[5]), 0, 0);
	if (fields.toISOString().slice(0, 16) !== value) return null;
	return dateFromZonedFields(fields, getUserTimeZone());
}

/** A UTC date used only to do arithmetic on the timezone's wall-clock fields. */
export function zonedDateFields(value: Date, timeZone: string): Date {
	const parts = getFieldFormatter(timeZone).formatToParts(value);
	const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	const result = new Date(0);
	result.setUTCFullYear(Number(fields.year), Number(fields.month) - 1, Number(fields.day));
	result.setUTCHours(Number(fields.hour), Number(fields.minute), Number(fields.second), value.getUTCMilliseconds());
	return result;
}

/** Use the earlier instant for repeated times and move forward across missing times. */
export function dateFromZonedFields(fields: Date, timeZone: string): Date {
	const wallTime = fields.getTime();
	const offsets = new Set([-1, 0, 1].map((day) => {
		const sample = new Date(wallTime + day * 86_400_000);
		return zonedDateFields(sample, timeZone).getTime() - sample.getTime();
	}));
	const candidates = [...offsets].map((offset) => new Date(wallTime - offset)).sort((a, b) => a.getTime() - b.getTime());
	return candidates.find((date) => zonedDateFields(date, timeZone).getTime() === wallTime)
		?? candidates.find((date) => zonedDateFields(date, timeZone).getTime() > wallTime)
		?? candidates[candidates.length - 1];
}

export function recentZonedDays(timeZone: string, count: number, now = new Date()): ZonedDay[] {
	const today = zonedDateFields(now, timeZone);
	today.setUTCHours(0, 0, 0, 0);
	return Array.from({ length: count }, (_, index) => {
		const day = new Date(today);
		day.setUTCDate(day.getUTCDate() - count + 1 + index);
		const next = new Date(day);
		next.setUTCDate(next.getUTCDate() + 1);
		return { date: day.toISOString().slice(0, 10), start: dateFromZonedFields(day, timeZone), end: dateFromZonedFields(next, timeZone) };
	});
}
