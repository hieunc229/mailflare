import { and, eq, gt, inArray, isNotNull, lte, or, ne, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEventOverrides, calendarEvents, users } from "@/db/schema";
import { isMissingColumnError } from "@/lib/database-errors";
import { sendPushContent } from "@/lib/push/server";
import { normalizeTimeZone } from "@/lib/time/utils";
import { expandToolEvents } from "./tool-occurrences";
import { chunkIds } from "./chunks";
import { MAX_REMINDER_MINUTES, formatReminderBody } from "./reminder-utils";

/** Events checked per cron run; the next run picks up the rest. */
const REMINDER_BATCH = 500;
/** Occurrences reminded per event per run, so a long lead time on a daily event cannot flood a device. */
const MAX_OCCURRENCES_PER_EVENT = 3;

/**
 * Five-minute cron: sends a push for each occurrence whose start minus the event's reminder offset has passed
 * and which has not started yet. The occurrence start is claimed on the row before sending, so overlapping runs
 * and retries never notify twice.
 */
export async function runCalendarReminders(env: CloudflareEnv, now: Date): Promise<void> {
	try {
		const db = getDb(env);
		const horizon = new Date(now.getTime() + MAX_REMINDER_MINUTES * 60_000);
		const rows = await db
			.select({ event: calendarEvents })
			.from(calendarEvents)
			// Accounts with Calendar hidden get no reminders: they cannot open the event anyway.
			.innerJoin(users, and(eq(users.id, calendarEvents.userId), eq(users.calendarEnabled, true)))
			.where(and(
				isNotNull(calendarEvents.reminderMinutes),
				lte(calendarEvents.startsAt, horizon),
				or(ne(calendarEvents.repeat, "none"), gt(calendarEvents.startsAt, now)),
				or(isNull(calendarEvents.repeatUntil), gt(calendarEvents.repeatUntil, now)),
			))
			.limit(REMINDER_BATCH);

		// Moved/extra occurrences remind at their override time: IN queries in D1-safe chunks.
		const overridesById = new Map<string, Array<{ occurrenceMs: number; startsAt: Date; endsAt: Date }>>();
		if (rows.length) {
			for (const chunk of chunkIds(rows.map(({ event }) => event.id))) {
				const overrideRows = await db.select().from(calendarEventOverrides).where(inArray(calendarEventOverrides.eventId, chunk));
				for (const row of overrideRows) {
					const list = overridesById.get(row.eventId) ?? [];
					list.push({ occurrenceMs: row.occurrenceMs, startsAt: row.startsAt, endsAt: row.endsAt });
					overridesById.set(row.eventId, list);
				}
			}
		}

		for (const { event } of rows) {
			const lead = (event.reminderMinutes ?? 0) * 60_000;
			const last = event.lastRemindedStart?.getTime() ?? 0;
			const overrides = overridesById.get(event.id);
			const due = expandToolEvents([event], now, new Date(now.getTime() + lead + 1), 500, overrides ? new Map([[event.id, overrides]]) : undefined)
				.map((occurrence) => ({ ...occurrence, start: new Date(occurrence.startsAt) }))
				.filter((occurrence) => occurrence.start > now && occurrence.start.getTime() - lead <= now.getTime() && occurrence.start.getTime() > last)
				.slice(0, MAX_OCCURRENCES_PER_EVENT);
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
	} catch (error) {
		// Before migrations 0078/0080 the reminder and calendar_enabled columns do not exist; nothing to remind about yet.
		if (!isMissingColumnError(error)) throw error;
	}
}
