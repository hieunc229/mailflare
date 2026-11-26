import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { calendarEvents, davCollections } from "@/db/schema";
import type { CalendarRole } from "@/lib/calendar/shares-types";
import { calendarCollectionId } from "./changes";

/**
 * One CalDAV calendar collection as the store functions see it (spec F9 D-12): its `dav_collections` id, the user who owns its
 * events (the row's `user_id`, D-2) and what the requesting user may do in it. The default calendar's events have no calendar id.
 */
export type CalendarScope = { id: string; ownerId: string; isDefault: boolean; role?: CalendarRole };

/** A user's own default calendar: what a store call that names only a user id means. */
export const defaultScope = (userId: string): CalendarScope => ({ id: calendarCollectionId(userId), ownerId: userId, isDefault: true, role: "owner" });

export const scopeOf = (scope: CalendarScope | string): CalendarScope => (typeof scope === "string" ? defaultScope(scope) : scope);

/**
 * The events of one collection: `calendar_id = id`, or for a default calendar the owner's events without a calendar (D-12). The owner is
 * always part of it (D-2). The owner's own default also holds the events whose calendar row is missing (a partial restore, spec 8.10),
 * so none is dropped; to anyone it is shared with it is the events with no calendar, as in the web list.
 */
export function inCalendar(scope: CalendarScope): SQL {
	const mine = eq(calendarEvents.userId, scope.ownerId);
	if (!scope.isDefault) return and(mine, eq(calendarEvents.calendarId, scope.id))!;
	const owned = !scope.role || scope.role === "owner";
	const dangling = sql`${calendarEvents.calendarId} not in (select ${davCollections.id} from ${davCollections} where ${davCollections.userId} = ${scope.ownerId} and ${davCollections.kind} = 'calendar')`;
	return and(mine, or(isNull(calendarEvents.calendarId), eq(calendarEvents.calendarId, scope.id), owned ? dangling : undefined))!;
}
