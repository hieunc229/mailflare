import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authenticateApiKeyValue } from "@/lib/api/key-auth";
import { hasScope } from "@/lib/api/key-auth";
import { buildCalendarFeed } from "@/lib/calendar/feed";

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
	// nothing but read the calendar is accepted here. A mail, JMAP or write key in this position is refused.
	if (!key || key.scopes.length !== 1 || !hasScope(key.scopes, "calendar:read")) return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
	const events = await getDb(env).select().from(calendarEvents).where(eq(calendarEvents.userId, key.user.id)).orderBy(calendarEvents.startsAt);
	const body = buildCalendarFeed(events.map((event) => ({ ...event, repeat: event.repeat })), { name: "Mailflare" });
	return new Response(body, { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="mailflare.ics"', "Cache-Control": "private, max-age=300", "X-Robots-Tag": "noindex" } });
}
