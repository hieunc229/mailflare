import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { readCalendarConfirmation } from "@/lib/calendar/confirmation";
import { runCalendarTool } from "@/lib/calendar/tools";

async function describe(env: CloudflareEnv, userId: string, name: string, input: unknown) {
	const body = input as { updates?: { eventId: string }[]; eventIds?: string[] };
	const ids = body.updates?.map((item) => item.eventId) ?? body.eventIds ?? [];
	const rows = ids.length ? await getDb(env).select({ id: calendarEvents.id, title: calendarEvents.title, repeat: calendarEvents.repeat, startsAt: calendarEvents.startsAt }).from(calendarEvents).where(and(eq(calendarEvents.userId, userId), inArray(calendarEvents.id, ids))) : [];
	return { action: name === "delete_events" ? "delete" : "update", events: rows.map((row) => ({ id: row.id, title: row.title, repeats: row.repeat !== "none", startsAt: row.startsAt.toISOString() })), changes: body.updates ?? null };
}

/** Preview what an assistant asked to do to the calendar. */
export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	const confirmation = await readCalendarConfirmation(env, new URL(request.url).searchParams.get("token") ?? "", user.id);
	if (!confirmation) return Response.json({ error: "This request has expired or is not valid" }, { status: 404 });
	return Response.json(await describe(env, user.id, confirmation.name, confirmation.input));
}

/** The signed-in user approves it; only now does the change run. */
export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const { token } = (await request.json().catch(() => ({}))) as { token?: string };
	const confirmation = await readCalendarConfirmation(env, token ?? "", user.id);
	if (!confirmation) return Response.json({ error: "This request has expired or is not valid" }, { status: 404 });
	try {
		return Response.json(await runCalendarTool({ env, user, confirmed: true }, confirmation.name, confirmation.input));
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "The change could not be applied" }, { status: 409 });
	}
}
