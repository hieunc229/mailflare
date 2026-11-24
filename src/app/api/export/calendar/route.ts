import { and, eq, gte, inArray, lt, ne, or, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEventOverrides, calendarEvents } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { buildCalendarFeed, type FeedOccurrenceOverride } from "@/lib/calendar/feed";
import { chunkIds } from "@/lib/calendar/chunks";

/**
 * One-shot .ics download of the calendar. /api/calendar/feed is the polled subscription keyed by a
 * calendar:read-only API key in the URL; this endpoint takes the normal session or Bearer key and the
 * file keeps what a feed hides: guests, their RSVP states and the reminder (download mode in the builder).
 * Optional start/end bound which events export the same way the events list does: an event qualifies
 * when it overlaps the range, and a series always exports whole, its rule is never clipped to the range.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:read");
	if (error) return error;
	const url = new URL(request.url);
	const start = new Date(url.searchParams.get("start") ?? "");
	const end = new Date(url.searchParams.get("end") ?? "");
	const where: (SQL | undefined)[] = [eq(calendarEvents.userId, user.id)];
	if (!Number.isNaN(end.getTime())) where.push(lt(calendarEvents.startsAt, end));
	if (!Number.isNaN(start.getTime())) where.push(or(gte(calendarEvents.endsAt, start), ne(calendarEvents.repeat, "none")));
	const db = getDb(env);
	const events = await db.select().from(calendarEvents).where(and(...where)).orderBy(calendarEvents.startsAt);
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
	const body = buildCalendarFeed(visible, { name: "Mailflare", download: true }, overrides);
	return new Response(body, { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="mailflare-calendar.ics"', "Cache-Control": "no-store" } });
}
