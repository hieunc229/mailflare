import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEventOverrides, calendarEvents } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authenticateApiKeyValue } from "@/lib/api/key-auth";
import { buildCalendarFeed, type FeedOccurrenceOverride } from "@/lib/calendar/feed";
import { chunkIds } from "@/lib/calendar/chunks";

/**
 * Read-only iCalendar subscription. Google Calendar, Outlook and Apple Calendar fetch a URL without
 * custom headers, so the API key (scope calendar:read) travels in the query string. Create a key that
 * has only that scope and revoke it from Settings to cut off the subscription.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const url = new URL(request.url);
	const key = await authenticateApiKeyValue(env, url.searchParams.get("key") ?? "");
	// A URL ends up in browser history, proxy logs and the subscribing service, so only a key that can do
	// nothing but read the calendar is accepted here (exact match: hasScope would also let a "*" key through). A mail, JMAP or write key in this position is refused.
	if (!key || key.scopes.length !== 1 || key.scopes[0] !== "calendar:read") return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
	const events = await getDb(env).select().from(calendarEvents).where(eq(calendarEvents.userId, key.user.id)).orderBy(calendarEvents.startsAt);
	// Invitations still waiting for an answer are not on the calendar yet, so other apps do not see them.
	const visible = events.filter((event) => event.responseStatus !== "needs-action").map((event) => ({ ...event, repeat: event.repeat }));
	const overrides = new Map<string, FeedOccurrenceOverride[]>();
	if (visible.length) {
		for (const chunk of chunkIds(visible.map((event) => event.id))) {
			const rows = await getDb(env).select().from(calendarEventOverrides).where(inArray(calendarEventOverrides.eventId, chunk));
			for (const row of rows) {
				const list = overrides.get(row.eventId) ?? [];
				list.push({ occurrenceMs: row.occurrenceMs, startsAt: row.startsAt, endsAt: row.endsAt });
				overrides.set(row.eventId, list);
			}
		}
	}
	const body = buildCalendarFeed(visible, { name: "Mailflare" }, overrides);
	return new Response(body, { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="mailflare.ics"', "Cache-Control": "private, max-age=300", "X-Robots-Tag": "noindex" } });
}
