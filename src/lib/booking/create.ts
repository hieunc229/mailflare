import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { BookingEventRecord } from "./types";

const COLUMNS = [
	"id", "user_id", "mailbox_id", "title", "description", "location", "attendees", "color", "repeat", "repeat_days",
	"excluded_occurrences", "time_zone", "starts_at", "ends_at", "created_at", "updated_at",
];

/**
 * Inserts one calendar event per host, but only when none of the hosts is busy, in a single statement so two
 * guests cannot take the same slot. Unanswered invitations (response_status needs-action) do not block, matching
 * availableBookingSlots, so every offered slot can be booked. Returns whether every host was booked.
 */
export async function createBookedCalendarEvents(env: CloudflareEnv, event: BookingEventRecord, guestName: string, guestEmail: string, startsAt: string, endsAt: string, guestEmails: string[] = [], notes = ""): Promise<boolean> {
	const hostIds = event.hostIds;
	const startSeconds = Math.floor(new Date(startsAt).getTime() / 1000);
	const endSeconds = Math.floor(new Date(endsAt).getTime() / 1000);
	const nowSeconds = Math.floor(Date.now() / 1000);
	const requested = sql.join(hostIds.map((id) => sql`select ${id} as host_id, ${newId("evt")} as event_id`), sql` union all `);
	const hostList = sql.join(hostIds.map((id) => sql`${id}`), sql`, `);
	const columns = sql.join(COLUMNS.map((name) => sql.identifier(name)), sql`, `);
	const description = [`Booked by ${guestName} (${guestEmail})`, notes].filter(Boolean).join("\n\n");
	const result = await getDb(env).run(sql`insert into ${calendarEvents} (${columns})
		select requested_hosts.event_id, requested_hosts.host_id, null, ${`${event.name} with ${guestName}`}, ${description}, ${event.location},
			${JSON.stringify([guestEmail, ...guestEmails])}, ${event.color}, 'none', '[]', '[]', ${event.timeZone}, ${startSeconds}, ${endSeconds}, ${nowSeconds}, ${nowSeconds}
		from (${requested}) requested_hosts
		where (select count(*) from ${calendarEvents} busy where busy.${sql.identifier("user_id")} in (${hostList}) and busy.${sql.identifier("repeat")} = 'none'
			and (busy.${sql.identifier("response_status")} is null or busy.${sql.identifier("response_status")} <> 'needs-action')
			and busy.${sql.identifier("starts_at")} < ${endSeconds} and busy.${sql.identifier("ends_at")} > ${startSeconds}) = 0`);
	return (result as unknown as { meta: { changes: number } }).meta.changes === hostIds.length;
}
