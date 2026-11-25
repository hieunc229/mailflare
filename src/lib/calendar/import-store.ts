import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { calendarEvents, domains, mailboxes } from "@/db/schema";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { parseIcsEventGroup } from "./ics-import";
import type { CalendarImportSummary, PlannedGroup } from "./import-store-types";
import { candidateIds, chunk, MAX_REQUEST_EVENTS, planCalendarImportRows, planGroupIds, ROWS_PER_INSERT, SELECT_CHUNK, STATEMENTS_PER_BATCH } from "./import-store-utils";

const MAX_ERRORS = 20;

/** The user's login address and mailbox addresses: they mean "me" in attendee and organizer lists. */
export async function listOwnAddresses(db: AppDatabase, userId: string, loginEmail: string, googleAddress?: string): Promise<string[]> {
	const rows = await db.select({ localPart: mailboxes.localPart, hostname: domains.hostname }).from(mailboxes)
		.innerJoin(domains, eq(domains.id, mailboxes.domainId)).where(eq(mailboxes.userId, userId)).limit(500);
	return [...new Set([loginEmail, ...(googleAddress ? [googleAddress] : []), ...rows.map((row) => `${row.localPart}@${row.hostname}`)].map((address) => address.toLowerCase()))];
}

export type CalendarImportInput = {
	userId: string;
	userZone: string;
	ownAddresses: string[];
	color: string;
	reminders: boolean;
	skipDeclined: boolean;
	/** The VEVENT blocks of one UID each. */
	groups: string[];
};

/**
 * Imports one request's worth of events. Bounded: at most MAX_REQUEST_EVENTS rows, id lookups in chunks of 90 and
 * inserts of 4 rows per statement, 50 statements per batch. Idempotent: every row has a deterministic id and is
 * inserted with ON CONFLICT DO NOTHING, so retrying a request (or re-importing the file) adds nothing twice.
 */
export async function importCalendarGroups(db: AppDatabase, input: CalendarImportInput): Promise<CalendarImportSummary> {
	const summary: CalendarImportSummary = { imported: 0, skipped: 0, simplified: 0, guessedZone: 0, failed: 0, errors: [] };
	const fail = (message: string) => { summary.failed++; if (summary.errors.length < MAX_ERRORS) summary.errors.push(message); };
	const planned: PlannedGroup[] = [];
	let events = 0;
	for (const text of input.groups) {
		const group = parseIcsEventGroup(text, { userZone: input.userZone, ownAddresses: input.ownAddresses, reminders: input.reminders, skipDeclined: input.skipDeclined });
		for (const message of group.failures) fail(message);
		const count = (group.master ? 1 : 0) + group.overrides.length;
		if (!group.uid) { if (count) fail("(event): no UID"); continue; }
		events += count;
		if (events > MAX_REQUEST_EVENTS) throw new RequestBodyTooLargeError("Too many events in one request");
		planned.push({ group, ids: await planGroupIds(input.userId, group) });
	}
	const existing = new Set<string>();
	for (const ids of chunk(candidateIds(planned), SELECT_CHUNK)) {
		const found = await db.select({ id: calendarEvents.id }).from(calendarEvents).where(and(eq(calendarEvents.userId, input.userId), inArray(calendarEvents.id, ids)));
		for (const { id } of found) existing.add(id);
	}
	const plan = planCalendarImportRows(planned, existing, input.userId, input.color);
	const statements = chunk(plan.rows, ROWS_PER_INSERT).map((rows) => db.insert(calendarEvents).values(rows).onConflictDoNothing());
	for (const batch of chunk(statements, STATEMENTS_PER_BATCH)) await db.batch(batch as never);
	summary.imported = plan.imported;
	summary.skipped = plan.skipped;
	summary.simplified = plan.simplified;
	summary.guessedZone = plan.guessedZone;
	return summary;
}
