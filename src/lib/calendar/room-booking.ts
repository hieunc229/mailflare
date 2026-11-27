import { and, eq, inArray, sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { calendarEvents, calendarResourceBookings, calendarResources } from "@/db/schema";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { requireGuard } from "@/lib/dav/writes";
import { newId } from "@/lib/ids";
import { expandRowBusy, loadOwnerZones, mergeBusy, needsOwnerZone, type BusyInterval } from "./busy-expand";
import { roomBusyIntervals, type RoomBusy } from "./room-busy";

type Db = ReturnType<typeof getDb>;

/** Spec F9 section 5: a booking is checked over the next 366 days or the next 500 occurrences, whichever ends first. */
export const ROOM_HORIZON_DAYS = 366;
export const ROOM_MAX_OCCURRENCES = 500;
/** Clashing dates reported to the organiser (D-8). */
export const MAX_CONFLICT_DATES = 10;
/** Tries before a booking gives up on winning the room and is declined. */
export const MAX_ROOM_ATTEMPTS = 5;
/** Work one save may spend reading its rooms' other bookings, in total: the same limit as one person's free/busy. */
export const ROOM_CHECK_BUDGET = 20_000;
const DAY = 86_400_000;

export type RoomOutcome = {
	resourceId: string;
	/**
	 * `unconfirmed`: nothing clashed, but the room could not be checked or won (every try lost a race, or the step failed). It is stored
	 * as `declined`, never accepted unchecked, and the caller tells the organiser to save again.
	 */
	status: "accepted" | "declined" | "unconfirmed";
	/** The first occurrence that clashed (null when accepted, or when the room could not be checked). */
	conflictAt: Date | null;
	/** Up to `MAX_CONFLICT_DATES` clashing starts, ISO. */
	occurrences: string[];
};
export type BookingResult = { rooms: RoomOutcome[] };

/** Starts of `mine` that overlap `others` (both sorted; touching is not overlapping). */
function clashes(mine: BusyInterval[], others: BusyInterval[]): number[] {
	const found: number[] = [];
	let cursor = 0;
	for (const [start, end] of mine) {
		while (cursor < others.length && others[cursor][1] <= start) cursor += 1;
		if (cursor < others.length && others[cursor][0] < end) found.push(start);
	}
	return found;
}

/**
 * Books `resourceIds` for an event (spec F9 D-8, section 8.5), replacing whatever it was booked for before: a room left out loses
 * its booking, a room named gets `accepted` when free over the event's occurrences and `declined` (the whole series, with the
 * first clashing dates) when any occurrence overlaps another accepted booking. First booking wins: a declined event holds nothing.
 * The occurrences are the master's and the moved occurrences of its own series (CalDAV override rows), over the next 366 days; the
 * room's other bookings are read only over the span those occupy, so a busy room does not make a short booking expensive.
 *
 * Race safety (no cross-statement locks on D1): each room carries a token. The booking reads the token, then the room's
 * bookings, then writes in one batch whose first statements swap the token for a fresh one only if it is still the one read, and
 * whose guard fails the whole batch when the swap matched nothing. Whoever writes a booking for a room first changes the token,
 * so a second booking that read before it cannot commit; it reads again, sees the winner, and is declined. Every writer that
 * changes a room's bookings goes through here, so every change moves the token. Only rooms that end up accepted are swapped. A
 * driver that cannot run a batch as one transaction (Neon over HTTP) can still let two writers interleave, so there an accepted
 * booking reads the room once more after writing and gives way to any overlapping accepted booking (D-8, failing closed: both
 * may decline). After `MAX_ROOM_ATTEMPTS` lost races the booking is declined without a clash date and reported as `unconfirmed`: never accepted unchecked.
 */
export async function bookRooms(db: Db, eventId: string, resourceIds: string[], options: { now?: Date; /** Rooms written `declined` without being checked: a booking that was declined stays so (a lapsed licence books nothing new). */ declined?: string[] } = {}): Promise<BookingResult> {
	const [row] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, eventId)).limit(1);
	if (!row) throw new Error("Event not found");
	const frozen = new Set(options.declined ?? []);
	const wanted = [...new Set(resourceIds)].filter((id) => !frozen.has(id));
	if (!wanted.length && !frozen.size) {
		await db.delete(calendarResourceBookings).where(eq(calendarResourceBookings.eventId, eventId));
		return { rooms: [] };
	}
	const now = options.now ?? new Date();
	const duration = row.endsAt.getTime() - row.startsAt.getTime();
	// Occurrences before now are history: nothing about them can be double-booked any more. An occurrence in progress still counts.
	const from = Math.max(row.startsAt.getTime(), now.getTime() - duration);
	const to = from + ROOM_HORIZON_DAYS * DAY;
	const zone = needsOwnerZone(row) ? (await loadOwnerZones(db, [row.userId])).get(row.userId) : undefined;
	const moved = await db.select().from(calendarEvents).where(and(eq(calendarEvents.davObjectId, eventId), inArray(calendarEvents.userId, [row.userId])));
	const mine = mergeBusy([...(duration > 0 ? expandRowBusy(row, zone, from, to, ROOM_MAX_OCCURRENCES).busy : []), ...moved.filter((other) => other.id !== eventId && other.endsAt > other.startsAt).flatMap((other) => expandRowBusy(other, zone, from, to, 1).busy)]);
	const spanStart = mine.length ? mine[0][0] : from;
	const spanEnd = mine.length ? mine[mine.length - 1][1] : from;
	const outcome = (resourceId: string, status: RoomOutcome["status"], found: number[]): RoomOutcome => ({ resourceId, status, conflictAt: found.length ? new Date(found[0]) : null, occurrences: found.slice(0, MAX_CONFLICT_DATES).map((at) => new Date(at).toISOString()) });
	/** One batch: the guards, then this event's bookings replaced. */
	const write = async (rooms: RoomOutcome[], guards: unknown[]) => {
		const created = new Date();
		const rows = rooms.map((room) => ({ id: newId("crb"), resourceId: room.resourceId, eventId, status: room.status === "unconfirmed" ? "declined" : room.status, conflictAt: room.conflictAt, createdAt: created }));
		await db.batch([...guards, db.delete(calendarResourceBookings).where(eq(calendarResourceBookings.eventId, eventId)), ...(rows.length ? [db.insert(calendarResourceBookings).values(rows)] : [])] as never);
	};
	for (let attempt = 0; attempt < MAX_ROOM_ATTEMPTS; attempt += 1) {
		// The token first: anything written after this read moves it, so a stale check cannot commit.
		const tokens = new Map((await db.select({ id: calendarResources.id, token: calendarResources.bookingToken }).from(calendarResources).where(inArray(calendarResources.id, [...wanted, ...frozen]))).map((room) => [room.id, room.token]));
		const ids = wanted.filter((id) => tokens.has(id));
		const held = [...frozen].filter((id) => tokens.has(id)).map((id) => outcome(id, "declined", []));
		if (!ids.length) { await write(held, []); return { rooms: held }; }
		const others = mine.length ? await roomBusyIntervals(db, ids, new Date(spanStart), new Date(spanEnd), { excludeEventId: eventId, budget: ROOM_CHECK_BUDGET, roomCap: ROOM_CHECK_BUDGET }) : new Map<string, RoomBusy>();
		const rooms = ids.map((id) => {
			const taken = others.get(id);
			// A room whose bookings could not all be read cannot be promised: declined, with no date.
			if (taken?.truncated) return outcome(id, "declined", []);
			const found = taken ? clashes(mine, taken.busy) : [];
			return outcome(id, found.length ? "declined" : "accepted", found);
		});
		// Only a room that ends up accepted needs its token swapped: a decline holds nothing, so a stale one is harmless.
		const guards = rooms.filter((room) => room.status === "accepted").flatMap(({ resourceId: id }) => {
			const next = crypto.randomUUID();
			return [
				db.update(calendarResources).set({ bookingToken: next }).where(and(eq(calendarResources.id, id), eq(calendarResources.bookingToken, tokens.get(id)!))),
				...requireGuard(db, sql`not exists (select 1 from ${calendarResources} where ${and(eq(calendarResources.id, id), eq(calendarResources.bookingToken, next))})`),
			];
		});
		try { await write([...rooms, ...held], guards); } catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			// Two saves that lost to each other would lose again together: wait a little, differently each time.
			await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * (attempt + 1)));
			continue;
		}
		// A driver whose batch is not one transaction (Neon over HTTP) can let two writers interleave between the swap and the insert, and
		// both end accepted. Such a driver re-reads once after writing and an accepted booking gives way to ANY overlapping accepted one
		// of another event, whichever came first: when two slipped in, the later check sees the other and declines, and both may decline.
		// That fails closed. Atomic drivers (D1, SQLite, PostgreSQL and MySQL over a connection) skip it.
		const accepted = rooms.filter((room) => room.status === "accepted" && mine.length);
		if (accepted.length && (db as { batchIsAtomic?: boolean }).batchIsAtomic === false) {
			const rivals = await roomBusyIntervals(db, accepted.map((room) => room.resourceId), new Date(spanStart), new Date(spanEnd), { excludeEventId: eventId, budget: ROOM_CHECK_BUDGET, roomCap: ROOM_CHECK_BUDGET });
			for (const room of accepted) {
				const taken = rivals.get(room.resourceId);
				const found = taken && !taken.truncated ? clashes(mine, taken.busy) : [];
				if (!found.length && !taken?.truncated) continue;
				Object.assign(room, outcome(room.resourceId, "declined", found));
				await db.update(calendarResourceBookings).set({ status: "declined", conflictAt: room.conflictAt }).where(and(eq(calendarResourceBookings.eventId, eventId), eq(calendarResourceBookings.resourceId, room.resourceId)));
			}
		}
		return { rooms: [...rooms, ...held] };
	}
	const known = new Set((await db.select({ id: calendarResources.id }).from(calendarResources).where(inArray(calendarResources.id, [...wanted, ...frozen]))).map((room) => room.id));
	const rooms = [...wanted.filter((id) => known.has(id)).map((id) => outcome(id, "unconfirmed", [])), ...[...frozen].filter((id) => known.has(id)).map((id) => outcome(id, "declined", []))];
	await write(rooms, []);
	return { rooms };
}
