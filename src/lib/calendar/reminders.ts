import { and, eq, gt, inArray, isNotNull, lte, or, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEventOverrides, calendarEvents, users } from "@/db/schema";
import { isMissingColumnError } from "@/lib/database-errors";
import { sendPushContent } from "@/lib/push/server";
import { normalizeTimeZone } from "@/lib/time/utils";
import { chunkIds } from "./chunks";
import { MAX_REMINDER_MINUTES, REMINDER_GRACE_MS, dueReminderOccurrences, formatReminderBody } from "./reminder-utils";

/** Events read per query; the run pages through each repeat kind by (start, id). */
const REMINDER_BATCH = 500;
/** Pages read per repeat kind per run, so one run stays bounded; hitting it is logged. */
const MAX_REMINDER_PAGES = 20;
/** Occurrences reminded per event per run, so a long lead time on a daily event cannot flood a device. */
const MAX_OCCURRENCES_PER_EVENT = 3;

export type ReminderRepeat = "none" | "daily" | "weekly" | "monthly" | "weekdays" | "yearly";
export const REMINDER_REPEATS: ReminderRepeat[] = ["none", "daily", "weekly", "monthly", "weekdays", "yearly"];

/**
 * One keyset page of events that can be due, for one repeat kind, ordered by (starts_at, id) so the
 * calendar_events_repeat_starts_idx index serves both the filter and the order. One-off events are bounded by a
 * window around now; recurring ones by repeat_until.
 */
export function reminderPage(db: ReturnType<typeof getDb>, now: Date, repeat: ReminderRepeat, after: { startsAt: Date; id: string } | null) {
	const graceStart = new Date(now.getTime() - REMINDER_GRACE_MS);
	const horizon = new Date(now.getTime() + MAX_REMINDER_MINUTES * 60_000);
	return db
		.select({ event: calendarEvents })
		.from(calendarEvents)
		// Accounts with Calendar hidden get no reminders: they cannot open the event anyway.
		.innerJoin(users, and(eq(users.id, calendarEvents.userId), eq(users.calendarEnabled, true)))
		.where(and(
			eq(calendarEvents.repeat, repeat),
			isNotNull(calendarEvents.reminderMinutes),
			lte(calendarEvents.startsAt, horizon),
			repeat === "none" ? gt(calendarEvents.startsAt, graceStart) : or(isNull(calendarEvents.repeatUntil), gt(calendarEvents.repeatUntil, graceStart)),
			after ? or(gt(calendarEvents.startsAt, after.startsAt), and(eq(calendarEvents.startsAt, after.startsAt), gt(calendarEvents.id, after.id))) : undefined,
		))
		.orderBy(calendarEvents.startsAt, calendarEvents.id)
		.limit(REMINDER_BATCH);
}

/**
 * Five-minute cron: sends a push for each occurrence whose start minus the event's reminder offset has passed
 * and which has not started yet. The occurrence start is claimed on the row before sending, so overlapping runs
 * and retries never notify twice.
 */
export async function runCalendarReminders(env: CloudflareEnv, now: Date): Promise<void> {
	try {
		const db = getDb(env);
		for (const repeat of REMINDER_REPEATS) {
			let cursor: { startsAt: Date; id: string } | null = null;
			for (let pageNumber = 1; ; pageNumber++) {
				const rows = await reminderPage(db, now, repeat, cursor);
				// Moved/extra occurrences remind at their override time: IN queries in D1-safe chunks.
				const overridesById = new Map<string, Array<{ occurrenceMs: number; startsAt: Date; endsAt: Date }>>();
				for (const chunk of chunkIds(rows.map(({ event }) => event.id))) {
					const overrideRows = await db.select().from(calendarEventOverrides).where(inArray(calendarEventOverrides.eventId, chunk));
					for (const row of overrideRows) {
						const list = overridesById.get(row.eventId) ?? [];
						list.push({ occurrenceMs: row.occurrenceMs, startsAt: row.startsAt, endsAt: row.endsAt });
						overridesById.set(row.eventId, list);
					}
				}
				for (const { event } of rows) {
					const due = dueReminderOccurrences(event, now, event.lastRemindedStart?.getTime() ?? 0, MAX_OCCURRENCES_PER_EVENT, overridesById.get(event.id));
					if (!due.length) continue;

					const newest = due[due.length - 1].start;
					const claimed = await db
						.update(calendarEvents)
						.set({ lastRemindedStart: newest })
						.where(and(
							eq(calendarEvents.id, event.id),
							or(isNull(calendarEvents.lastRemindedStart), sql`${calendarEvents.lastRemindedStart} < ${newest}`),
						))
						.returning({ id: calendarEvents.id });
					if (!claimed.length) continue;

					const zone = normalizeTimeZone(event.timeZone);
					for (const occurrence of due) {
						await sendPushContent(env, [event.userId], {
							title: event.title.slice(0, 180),
							body: formatReminderBody(occurrence.start, zone, event.location),
							tag: `calendar:${event.id}:${occurrence.start.getTime()}`,
							url: "/calendar",
						});
					}
				}
				if (rows.length < REMINDER_BATCH) break;
				if (pageNumber >= MAX_REMINDER_PAGES) {
					console.warn(`Calendar reminders: stopped after ${MAX_REMINDER_PAGES * REMINDER_BATCH} ${repeat} events; later events were not checked this run`);
					break;
				}
				const last = rows[rows.length - 1].event;
				cursor = { startsAt: last.startsAt, id: last.id };
			}
		}
	} catch (error) {
		// Before migrations 0078/0080 the reminder and calendar_enabled columns do not exist; nothing to remind about yet.
		if (!isMissingColumnError(error)) throw error;
	}
}
