import { getDisplayLocale } from "@/lib/time/utils";
import { defaultTranslator } from "@/lib/i18n/utils";
import type { BookingSlot } from "../types";
import { isValidTimeZone } from "@/lib/time/utils";
import type { BookingPageSelection } from "./types";

export function readBookingPageSelection(search: string): BookingPageSelection {
	const params = new URLSearchParams(search);
	const rawDate = params.get("date");
	const parsedDate = rawDate ? new Date(`${rawDate}T12:00:00Z`) : null;
	const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && parsedDate && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === rawDate ? rawDate : null;
	const rawSlot = params.get("slot");
	const parsedSlot = rawSlot ? new Date(rawSlot) : null;
	const slotStartsAt = parsedSlot && !Number.isNaN(parsedSlot.getTime()) ? parsedSlot.toISOString() : null;
	const rawTimeZone = params.get("timeZone");
	return { date, slotStartsAt, timeZone: rawTimeZone && isValidTimeZone(rawTimeZone) ? rawTimeZone : null };
}

export function writeBookingPageSelection(date: string, slotStartsAt: string | null, timeZone: string, replace = false): void {
	const url = new URL(window.location.href);
	url.searchParams.set("date", date);
	url.searchParams.set("timeZone", timeZone);
	if (slotStartsAt) url.searchParams.set("slot", slotStartsAt);
	else url.searchParams.delete("slot");
	const nextUrl = `${url.pathname}${url.search}${url.hash}`;
	if (replace) window.history.replaceState(window.history.state, "", nextUrl);
	else window.history.pushState(window.history.state, "", nextUrl);
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

export function localDateForSlot(slot: BookingSlot, timeZone: string): string {
	let formatter = dateFormatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
		if (dateFormatters.size >= 64) dateFormatters.clear();
		dateFormatters.set(timeZone, formatter);
	}
	const parts = formatter.formatToParts(new Date(slot.startsAt));
	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return `${values.year}-${values.month}-${values.day}`;
}

export function calendarDays(month: string): string[] {
	const [year, monthNumber] = month.split("-").map(Number);
	const first = new Date(Date.UTC(year, monthNumber - 1, 1));
	const count = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
	const blanks = (first.getUTCDay() + 6) % 7;
	const trailing = (7 - (blanks + count) % 7) % 7;
	return [...Array(blanks).fill(""), ...Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`), ...Array(trailing).fill("")];
}

export function moveMonth(month: string, offset: number): string {
	const [year, monthNumber] = month.split("-").map(Number);
	return new Date(Date.UTC(year, monthNumber - 1 + offset, 1)).toISOString().slice(0, 7);
}

export function formatCalendarDate(date: string, options: Intl.DateTimeFormatOptions): string {
	return new Intl.DateTimeFormat(getDisplayLocale(), { ...options, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

export function bookingTimeZones(eventTimeZone: string, selectedTimeZone: string): string[] {
	const supported = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
	return [...new Set([selectedTimeZone, eventTimeZone, "UTC", ...supported])].sort((a, b) => a.localeCompare(b));
}

export async function submitPublicBooking(endpoint: string, startsAt: string, name: string, email: string, guestEmails: string, notes: string): Promise<void> {
	const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startsAt, name, email, guestEmails, notes }) });
	const data = await response.json() as { error?: string };
	if (!response.ok) throw new Error(data.error ?? defaultTranslator("public.bookFailedShort"));
}
