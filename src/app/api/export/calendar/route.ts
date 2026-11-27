import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEventOverrides, calendarEvents } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { buildCalendarFeed, ExportLimitError, type FeedOccurrenceOverride } from "@/lib/calendar/feed";
import { chunkIds } from "@/lib/calendar/chunks";

/**
 * One-shot .ics download of the calendar. /api/calendar/feed is the polled subscription keyed by a
 * calendar:read-only API key in the URL; this endpoint takes the normal session or Bearer key and the
 * file keeps what a feed hides: guests, their RSVP states and the reminder (download mode in the builder).
 * Optional start/end bound which events export the same way the events list does: an event qualifies
 * when it overlaps the range, and a series always exports whole, its rule is never clipped to the range.
 * A series whose master falls outside the range still qualifies when an exception or extra lands inside it.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:read");
	if (error) return error;
	const url = new URL(request.url);
	const start = new Date(url.searchParams.get("start") ?? "");
	const end = new Date(url.searchParams.get("end") ?? "");
	const hasStart = !Number.isNaN(start.getTime());
	const hasEnd = !Number.isNaN(end.getTime());
	const db = getDb(env);
	const events = await db.select().from(calendarEvents).where(eq(calendarEvents.userId, user.id)).orderBy(calendarEvents.startsAt);
	// Invitations still waiting for an answer are not on the calendar yet, so they do not export either.
	const visible = events.filter((event) => event.responseStatus !== "needs-action");
	const overrides = new Map<string, FeedOccurrenceOverride[]>();
	if (visible.length) {
		for (const chunk of chunkIds(visible.map((event) => event.id))) {
			for (const row of await db.select().from(calendarEventOverrides).where(inArray(calendarEventOverrides.eventId, chunk))) {
				const list = overrides.get(row.eventId) ?? [];
				list.push({ occurrenceMs: row.occurrenceMs, startsAt: row.startsAt, endsAt: row.endsAt, title: row.title, description: row.description, location: row.location });
				overrides.set(row.eventId, list);
			}
		}
	}
	// A master matches the events-list rule — overlaps, or is a series that can still recur — and a series
	// outside the range is kept when any of its exceptions or extra occurrences land inside it.
	const overlaps = (startsAt: Date, endsAt: Date) => (!hasEnd || startsAt < end) && (!hasStart || endsAt >= start);
	const selected = hasStart || hasEnd
		? visible.filter((event) => overlaps(event.startsAt, event.endsAt) || (hasStart && event.repeat !== "none" && (!hasEnd || event.startsAt < end)) || (overrides.get(event.id) ?? []).some((override) => overlaps(override.startsAt, override.endsAt)))
		: visible;
	// Exporting every VTIMEZONE a pathological calendar needs can exceed the probe budget; that fails
	// explicitly (never a degraded file) unless ?full=1 opts into the unbounded scan.
	try {
		const body = buildCalendarFeed(selected, { name: "Mailflare", download: true, full: url.searchParams.get("full") === "1" }, overrides);
		return new Response(body, { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="mailflare-calendar.ics"', "Cache-Control": "no-store" } });
	} catch (error) {
		if (error instanceof ExportLimitError) return NextResponse.json({ error: "EXPORT_LIMIT_EXCEEDED", detail: error.message }, { status: 413, headers: { "Cache-Control": "no-store" } });
		throw error;
	}
}
