import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, calendarResources, davCalendarObjects } from "@/db/schema";
import { inviteEventId } from "./invite-id";
import { expandRowBusy, loadOwnerZones, mergeBusy, needsOwnerZone, overlapsWindow, USER_CHUNK, type BusyInterval } from "./busy-expand";
import { roomBusyIntervals } from "./room-busy";
import { isBusyEvent } from "./visibility";

/** People per request and the longest window (spec F9 section 5, D-9). */
export const MAX_FREE_BUSY_IDS = 50;
export const MAX_FREE_BUSY_DAYS = 62;
/** Occurrences read per series in one window; a daily series needs 63. */
const MAX_OCCURRENCES = 2000;
/**
 * Work one request may spend expanding series, counted as one per series plus one per occurrence found, shared equally by the
 * people asked about (one alone has all of it). A person who spends their share gets their whole window as busy, not free: a
 * request that cannot be answered exactly never answers "free". Someone else's heavy calendar costs the others nothing.
 */
export const MAX_EXPANSION_BUDGET = 20_000;
const DAY = 86_400_000;

export { mergeBusy, type BusyInterval };

export type FreeBusyTargets = {
	userIds: string[];
	/** Rooms and equipment: answered from their accepted bookings (D-7), keyed by resource id in the result. */
	resourceIds?: string[];
	/** An event being edited: it, its moved occurrences and every guest's copy of its invitation are left out, so it does not clash with itself. The caller must have checked the right to edit it. */
	excludeEventId?: string;
	/** Start (ms) of an occurrence of the series being edited: saving it splits the series there, so that occurrence and every later one (and the moved rows from it on) are left out; the earlier ones still count. */
	excludeOccurrence?: number;
	/**
	 * Also look up the UID a CalDAV client stored for that event and leave out copies carrying it. Only for the event's owner: for
	 * anyone else the stored UID is never read, so it cannot be probed. Invitations Mailflare sends always carry `<id>@mailflare`.
	 */
	excludeStoredUid?: boolean;
};

/**
 * The one answer to "when is this person busy" (D-9): the editor, the publish URL and CalDAV all read it, so they cannot disagree.
 * Callers decide who may see whom (`viewableFreeBusyUsers`); this only turns events into intervals. Every calendar a person owns
 * counts (a row's user is its calendar's owner, D-2). Events marked free, invitations not yet accepted, declined and cancelled
 * ones do not (D-6); private events do, as bare intervals. A series is expanded with its exclusions, and a moved occurrence is a
 * row of its own, so it is busy at its new time only. A series too heavy to expand makes the whole window busy: unknown is never free.
 * Everyone asked for gets an entry (empty when free). At most 50 people and 62 days.
 */
export async function busyIntervals(env: CloudflareEnv, targets: FreeBusyTargets, start: Date, end: Date): Promise<Map<string, BusyInterval[]>> {
	const from = start.getTime();
	const to = end.getTime();
	const db = getDb(env);
	const ids = [...new Set(targets.userIds)];
	const roomIds = [...new Set(targets.resourceIds ?? [])];
	if (ids.length + roomIds.length > MAX_FREE_BUSY_IDS) throw new RangeError(`Free/busy covers at most ${MAX_FREE_BUSY_IDS} people and rooms at a time`);
	if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new RangeError("Choose a start before the end");
	if (to - from > MAX_FREE_BUSY_DAYS * DAY) throw new RangeError(`Free/busy covers at most ${MAX_FREE_BUSY_DAYS} days at a time`);
	// The event being edited and each guest's copy of its invitation, which carries UID `<id>@mailflare` (and the CalDAV client's own UID when the owner asks).
	const excluded = new Set<string>();
	if (targets.excludeEventId) {
		const uids = [`${targets.excludeEventId}@mailflare`];
		if (targets.excludeStoredUid) {
			const [stored] = await db.select({ uid: davCalendarObjects.uid }).from(davCalendarObjects).where(eq(davCalendarObjects.id, targets.excludeEventId)).limit(1);
			if (stored?.uid && !uids.includes(stored.uid)) uids.push(stored.uid);
		}
		excluded.add(targets.excludeEventId);
		for (const id of ids) for (const uid of uids) excluded.add(await inviteEventId(id, uid));
	}
	const share = Math.floor(MAX_EXPANSION_BUDGET / Math.max(ids.length, 1));
	const spent = new Map<string, number>();
	const collected = new Map<string, BusyInterval[]>(ids.map((id) => [id, []]));
	for (let index = 0; index < ids.length; index += USER_CHUNK) {
		const rows = await db.select({
			id: calendarEvents.id, davObjectId: calendarEvents.davObjectId, userId: calendarEvents.userId, startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt, timeZone: calendarEvents.timeZone, repeat: calendarEvents.repeat, rrule: calendarEvents.rrule,
			repeatDays: calendarEvents.repeatDays, repeatAnchorDay: calendarEvents.repeatAnchorDay, repeatUntil: calendarEvents.repeatUntil, excludedOccurrences: calendarEvents.excludedOccurrences,
			recurrenceId: calendarEvents.recurrenceId, transparent: calendarEvents.transparent, responseStatus: calendarEvents.responseStatus, allDay: calendarEvents.allDay,
		}).from(calendarEvents).where(and(inArray(calendarEvents.userId, ids.slice(index, index + USER_CHUNK)), overlapsWindow(start, end)));
		// An all-day event is stored as the instants of its midnights. A repeating or all-day row with no zone of its own is a legacy one, and the calendar view expands
		// those in the viewer's own zone (`calendarTimeZone` in the calendar's utils.ts, the user's setting), which for the owner is `users.time_zone`; so this does too, and the two agree.
		const ownerZones = rows.some((row) => needsOwnerZone(row)) ? await loadOwnerZones(db, ids.slice(index, index + USER_CHUNK)) : new Map<string, string>();
		for (const row of rows) {
			if (!isBusyEvent(row)) continue;
			// The event being edited: all of it, or (with an occurrence named) that occurrence and the moved row that replaced it.
			const edited = excluded.has(row.id);
			const movedRow = !!targets.excludeEventId && row.davObjectId === targets.excludeEventId && row.id !== targets.excludeEventId;
			if (targets.excludeOccurrence === undefined ? edited || movedRow : movedRow && row.recurrenceId !== null && row.recurrenceId.getTime() >= targets.excludeOccurrence) continue;
			if (row.endsAt.getTime() - row.startsAt.getTime() <= 0) continue;
			const list = collected.get(row.userId)!;
			// What is left of this person's share is the limit on the expansion itself, so one series cannot carry them far past it; reaching the limit counts as running out.
			const used = spent.get(row.userId) ?? 0;
			const limit = Math.min(MAX_OCCURRENCES, share - used);
			if (limit <= 0) { list.push([from, to]); continue; }
			const walked = expandRowBusy(row, ownerZones.get(row.userId), from, to, limit, edited && targets.excludeOccurrence !== undefined ? targets.excludeOccurrence : undefined);
			spent.set(row.userId, used + walked.used);
			if (walked.truncated) list.push([from, to]);
			else list.push(...walked.busy);
		}
	}
	// A room is taken when an accepted booking says so, whatever its organiser shows as; one that cannot be read in full is busy all window, never free.
	// Only rooms that exist get an entry: an id that names nothing is left out, as it was before rooms existed.
	const known = roomIds.length ? (await db.select({ id: calendarResources.id }).from(calendarResources).where(inArray(calendarResources.id, roomIds))).map((room) => room.id) : [];
	if (known.length) for (const [id, room] of await roomBusyIntervals(db, known, start, end, { excludeEventId: targets.excludeEventId, excludeOccurrence: targets.excludeOccurrence })) collected.set(id, room.truncated ? [[from, to]] : room.busy);
	return new Map([...collected].map(([id, list]) => [id, mergeBusy(list)]));
}
