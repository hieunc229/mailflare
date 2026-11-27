import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { busyIntervals, type BusyInterval } from "@/lib/calendar/free-busy";
import { resolveFreeBusyAddresses, viewableFreeBusyUsers } from "@/lib/calendar/free-busy-access";
import { parseCalendarOccurrenceId } from "@/lib/calendar/recurrence";
import { getEventAccess, roleAtLeast } from "@/lib/calendar/shares";
import { parseFreeBusyRequest } from "@/lib/calendar/free-busy-request";
import { readJsonObject } from "@/lib/http/request";

const NO_STORE = { "Cache-Control": "no-store" };
/**
 * The event the caller is editing, only when they may edit it (an occurrence id names its series and where saving would split it). Anything else, a missing event
 * included, gives null and no sign of why, so the field cannot be used to probe events or calendars.
 */
async function editableEvent(env: CloudflareEnv, user: { id: string }, requested: string | null): Promise<{ id: string; owner: boolean; occurrence?: number } | null> {
	if (!requested) return null;
	const named = parseCalendarOccurrenceId(requested);
	const db = getDb(env);
	const [event] = await db.select({ id: calendarEvents.id, repeat: calendarEvents.repeat, userId: calendarEvents.userId, calendarId: calendarEvents.calendarId, davObjectId: calendarEvents.davObjectId, recurrenceId: calendarEvents.recurrenceId }).from(calendarEvents).where(eq(calendarEvents.id, named?.seriesId ?? requested)).limit(1);
	if (!event || !roleAtLeast(await getEventAccess(db, user, event), "edit")) return null;
	const owner = event.userId === user.id;
	// Saving an occurrence of a repeating series splits it there, so that occurrence and the later ones move; a custom rule cannot be split, so it moves whole.
	if (named) return event.repeat === "custom" ? { id: event.id, owner } : { id: event.id, owner, occurrence: named.startsAt.getTime() };
	// A moved occurrence is a row of its own, and saving it changes that row alone: only it and its guests' copies (UID <its id>@mailflare) are left out, not the series.
	// Like the save, this needs the right to edit the series' row too.
	if (event.davObjectId && event.davObjectId !== event.id) {
		const [head] = await db.select({ userId: calendarEvents.userId, calendarId: calendarEvents.calendarId }).from(calendarEvents).where(eq(calendarEvents.id, event.davObjectId)).limit(1);
		if (head && !roleAtLeast(await getEventAccess(db, user, head), "edit")) return null;
	}
	return { id: event.id, owner };
}

const iso = ([from, to]: BusyInterval) => [new Date(from).toISOString(), new Date(to).toISOString()];

/**
 * Busy times of the people named by address (spec F9 8.4, D-10). Whoever the caller may not see, whoever has no account, and any
 * outside address all get the same `{ status: "unknown" }`, so the answer says nothing about who has an account here.
 * `resourceIds` names rooms (D-7, D-10): any caller allowed to use the calendar sees a room's busy times, whatever their licence
 * (existing rooms stay readable), and an id that is not a room is left out of the answer. Rooms are keyed by their id.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:read");
	if (error) return error;
	const body = await readJsonObject(request);
	const parsed = body ? parseFreeBusyRequest(body) : "Invalid JSON body";
	if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400, headers: NO_STORE });
	const editing = await editableEvent(env, user, parsed.excludeEventId);
	const accounts = await resolveFreeBusyAddresses(env, parsed.addresses);
	const visible = await viewableFreeBusyUsers(env, user.id, [...new Set(accounts.values())]);
	const busy = visible.size || parsed.resourceIds.length ? await busyIntervals(env, { userIds: [...visible], resourceIds: parsed.resourceIds, excludeEventId: editing?.id, excludeOccurrence: editing?.occurrence, excludeStoredUid: editing?.owner }, parsed.start, parsed.end) : new Map<string, BusyInterval[]>();
	const results: Record<string, { status: "ok"; busy: string[][] } | { status: "unknown" }> = {};
	for (const address of parsed.addresses) {
		const id = accounts.get(address);
		results[address] = id && visible.has(id) ? { status: "ok", busy: (busy.get(id) ?? []).map(iso) } : { status: "unknown" };
	}
	// A room is answered under its id; an id that names no room is left out (the editor reads a missing key as unknown).
	for (const id of parsed.resourceIds) if (busy.has(id)) results[id] = { status: "ok", busy: busy.get(id)!.map(iso) };
	return NextResponse.json({ results }, { headers: NO_STORE });
}
