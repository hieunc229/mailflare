import { and, eq, gt, isNotNull, lte, or, ne, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { isMissingColumnError } from "@/lib/database-errors";
import { sendPushContent } from "@/lib/push/server";
import { normalizeTimeZone } from "@/lib/time/utils";
import { expandToolEvents } from "./tool-occurrences";
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
			.select()
			.from(calendarEvents)
			.where(and(
				isNotNull(calendarEvents.reminderMinutes),
				lte(calendarEvents.startsAt, horizon),
				or(ne(calendarEvents.repeat, "none"), gt(calendarEvents.startsAt, now)),
				or(isNull(calendarEvents.repeatUntil), gt(calendarEvents.repeatUntil, now)),
			))
			.limit(REMINDER_BATCH);

		for (const event of rows) {
			const lead = (event.reminderMinutes ?? 0) * 60_000;
			const last = event.lastRemindedStart?.getTime() ?? 0;
			const due = expandToolEvents([event], now, new Date(now.getTime() + lead + 1))
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
		// Before migration 0078 the reminder columns do not exist; there is nothing to remind about yet.
		if (!isMissingColumnError(error)) throw error;
	}
}
