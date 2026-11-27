/**
 * Exercises the database layer against any DATABASE_URL: migrations, the query shapes the app relies on
 * (insert/select/update, returning, onConflict*, raw sql, batch), the triggers and search.
 * Run with `npm run db:smoke -- <DATABASE_URL> [driver]`; PGlite needs no server (`pglite://memory`), and SQLite runs in memory with
 * `file::memory:` (`sqlite://file::memory:` is a file literally named `file::memory:` in the working directory).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { createDb } from "@/db";
import { users, domains, mailboxes, messages, calendarEvents, calendarShares, davChanges, calendarResources, calendarResourceBookings, contacts, contactDetails, davCalendarObjects, davCards, davSyncState, davCollections, folders, jmapChanges, appSettings, webhooks, spamTokenStats, spamReputation, mailboxPromotionSettings, emailSuppressions, domainDeliverability } from "@/db/schema";
import { getDatabaseConfig } from "@/db/with-database";
import { openExternalDatabase } from "@/db/external";
import { mirrorCardStatements } from "@/lib/dav/contact-mirror";
import { seedStep } from "@/lib/dav/contact-seed";
import { requireGuard, staleGuard } from "@/lib/dav/writes";
import { syncPositions } from "@/lib/dav/changes";
import { moveSeriesStatements } from "@/lib/calendar/series-rows";
import { calendarExistsGuard } from "@/lib/calendar/calendars";
import { listVisibleEvents } from "@/lib/calendar/event-list";
import { busyIntervals } from "@/lib/calendar/free-busy";
import { bookRooms } from "@/lib/calendar/room-booking";
import { isOrgFreeBusyEnabled, resolveFreeBusyAddresses, viewableFreeBusyUsers } from "@/lib/calendar/free-busy-access";
import { calendarScopes, changeShare, getCalendarRole, grantShare, listVisibleCalendars, revokeShare } from "@/lib/calendar/shares";
import { applyPendingMigrations, getMigrationStatus } from "@/lib/migrations/service";
import { buildSearchConditions } from "@/lib/search/conditions";
import { createBookedCalendarEvents } from "@/lib/booking/create";
import { importCalendarGroups } from "@/lib/calendar/import-store";
import { importContacts } from "@/lib/contacts/import-store";
import { exportDatabaseRecords, restoreDatabaseRecords } from "@/lib/backups/export";
import { getSearchIndexStatus } from "@/lib/search/index-admin";
import { recordReputationObservation } from "@/lib/spam/repository";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { listSubscriptions } from "@/lib/promotions/subscriptions";
import { runPromotionsBackfill, selectBackfillCandidates } from "@/lib/promotions/backfill";
import { recordSuppression } from "@/lib/deliverability/suppression";
import { ingestReportMail } from "@/lib/deliverability/ingest";
import { runDeliverabilityDaily } from "@/lib/deliverability/daily";
import { getDmarcStats } from "@/lib/deliverability/dmarc-stats";
import { getTlsStats } from "@/lib/deliverability/tls-stats";
import { markMtaStsVerified, updateMtaSts, type MtaStsDeps } from "@/lib/deliverability/mta-sts-admin";
import { assertDomainRemovable, assertMxChangeAllowed } from "@/lib/deliverability/mta-sts-guard";
import { serveMtaStsPolicy } from "@/lib/deliverability/mta-sts-serve";
import { gzipSync } from "node:zlib";

const [url, driver] = process.argv.slice(2);
if (!url) throw new Error("usage: db-smoke <DATABASE_URL> [driver]");

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => {
	checks.push([name, ok]);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};

const config = getDatabaseConfig({ DATABASE_URL: url, DATABASE_DRIVER: driver } as never);
const external = openExternalDatabase(config, true);
const d1 = external as unknown as D1Database;
console.log(`dialect=${config.dialect} driver=${config.driver}`);

const applied = await applyPendingMigrations(d1);
check("migrations apply", applied.ready && applied.applied.length > 0);
check("migrations idempotent", (await applyPendingMigrations(d1)).applied.length === 0 && (await getMigrationStatus(d1)).ready);

const db = createDb(d1);
const stamp = Date.now();
const userId = `usr_${stamp}`;
await db.insert(users).values({ id: userId, email: `a${stamp}@example.com`, passwordHash: "x", name: "A" });
const [user] = await db.select().from(users).where(eq(users.id, userId));
check("insert + select", user?.email === `a${stamp}@example.com` && user.createdAt instanceof Date && user.disabled === false);
check("timestamp is a recent Date", Math.abs(user.createdAt.getTime() - Date.now()) < 60_000);

await db.insert(domains).values({ id: `dom_${stamp}`, userId, hostname: `${stamp}.example.com`, zoneId: "z" });
await db.insert(mailboxes).values({ id: `mbx_${stamp}`, userId, domainId: `dom_${stamp}`, localPart: "me" });
await db.insert(messages).values({ id: `msg_${stamp}`, userId, mailboxId: `mbx_${stamp}`, direction: "inbound", fromAddr: "x@y.z", toAddr: "me@example.com", subject: "Quarterly Report", textBody: "numbers inside", status: "received" } as never);
const changes = await db.select().from(jmapChanges).where(eq(jmapChanges.mailboxId, `mbx_${stamp}`));
check("trigger wrote jmap_changes", changes.length >= 1 && changes[0].change === "created");
const revisions = await db.all<{ revision: number }>(sql`SELECT revision FROM jmap_mailbox_revisions WHERE mailbox_id = ${`mbx_${stamp}`}`);
check("trigger bumped jmap revision", Number(revisions[0]?.revision) >= 1);

await db.update(messages).set({ status: "trash" }).where(eq(messages.id, `msg_${stamp}`));
const [trashed] = await db.select({ trashedAt: messages.trashedAt, status: messages.status }).from(messages).where(eq(messages.id, `msg_${stamp}`));
check("trigger set trashed_at", trashed.status === "trash" && trashed.trashedAt instanceof Date);
await db.update(messages).set({ status: "received" }).where(eq(messages.id, `msg_${stamp}`));
const [restored] = await db.select({ trashedAt: messages.trashedAt }).from(messages).where(eq(messages.id, `msg_${stamp}`));
check("trigger cleared trashed_at", restored.trashedAt === null);

const claimed = await db.update(messages).set({ starred: true }).where(and(eq(messages.id, `msg_${stamp}`), eq(messages.starred, false))).returning({ id: messages.id });
check("update returning (claim)", claimed.length === 1 && claimed[0].id === `msg_${stamp}`);
const lost = await db.update(messages).set({ starred: true }).where(and(eq(messages.id, `msg_${stamp}`), eq(messages.starred, false))).returning({ id: messages.id });
check("update returning (lost claim)", lost.length === 0);

const inserted = await db.insert(folders).values({ id: `fld_${stamp}`, userId, mailboxId: `mbx_${stamp}`, name: "F" } as never).onConflictDoNothing().returning({ id: folders.id });
check("insert onConflictDoNothing returning", inserted.length === 1);
const duplicate = await db.insert(folders).values({ id: `fld_${stamp}`, userId, mailboxId: `mbx_${stamp}`, name: "F" } as never).onConflictDoNothing().returning({ id: folders.id });
check("insert onConflictDoNothing (duplicate)", duplicate.length === 0);

await db.insert(spamTokenStats).values({ mailboxId: `mbx_${stamp}`, token: "t", spamCount: 1, hamCount: 0, updatedAt: new Date() } as never)
	.onConflictDoUpdate({ target: [spamTokenStats.mailboxId, spamTokenStats.token], set: { spamCount: sql`${spamTokenStats.spamCount} + 1` } });
await db.insert(spamTokenStats).values({ mailboxId: `mbx_${stamp}`, token: "t", spamCount: 1, hamCount: 0, updatedAt: new Date() } as never)
	.onConflictDoUpdate({ target: [spamTokenStats.mailboxId, spamTokenStats.token], set: { spamCount: sql`${spamTokenStats.spamCount} + 1` } });
const [stat] = await db.select().from(spamTokenStats).where(eq(spamTokenStats.mailboxId, `mbx_${stamp}`));
check("upsert increments", stat?.spamCount === 2);

const [{ n }] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM messages WHERE mailbox_id = ${`mbx_${stamp}`}`);
check("raw sql all()", Number(n) === 1);
const run = await db.run(sql`UPDATE messages SET starred = ${false} WHERE id = ${`msg_${stamp}`}`);
check("raw sql run() reports changes", (run as { meta: { changes: number } }).meta.changes === 1);

await db.batch([
	db.update(messages).set({ subject: "batched" }).where(eq(messages.id, `msg_${stamp}`)),
	db.insert(webhooks).values({ id: `wh_${stamp}`, userId, url: "https://example.com", secret: "s", events: "[]" } as never),
] as never);
const [batched] = await db.select({ subject: messages.subject }).from(messages).where(eq(messages.id, `msg_${stamp}`));
check("batch", batched.subject === "batched");

const prepared = await d1.prepare("SELECT count(*) AS n FROM messages WHERE mailbox_id = ?").bind(`mbx_${stamp}`).first<{ n: number }>();
check("D1-compatible prepare().bind().first()", Number(prepared?.n) === 1);
const batchResults = await d1.batch([d1.prepare("SELECT 1 AS one"), d1.prepare("SELECT 2 AS two")]);
check("D1-compatible batch()", batchResults.length === 2);

await db.update(messages).set({ subject: "Quarterly Report" }).where(eq(messages.id, `msg_${stamp}`));
for (const [query, expected] of [["quarterly", 1], ["subject:report", 1], ["from:x@y.z numbers", 1], ["absent-term", 0], ["-quarterly", 0]] as const) {
	const found = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, `mbx_${stamp}`), ...buildSearchConditions(query)));
	check(`search "${query}"`, found.length === expected);
}

const env = { DB: d1 } as unknown as CloudflareEnv;
const event = { hostIds: [userId], name: "Intro", location: "Zoom", color: "blue", timeZone: "UTC" } as never;
const startsAt = new Date(Date.now() + 86_400_000).toISOString();
const endsAt = new Date(Date.now() + 86_400_000 + 1_800_000).toISOString();
check("booking inserts", (await createBookedCalendarEvents(env, event, "Guest", "g@example.com", startsAt, endsAt)) === true);
check("booking refuses a busy slot", (await createBookedCalendarEvents(env, event, "Guest", "g@example.com", startsAt, endsAt)) === false);

const importGroups = Array.from({ length: 9 }, (_, n) => ["BEGIN:VEVENT", `UID:smoke-${n}@google.com`, "DTSTART:20261104T090000Z", "RRULE:FREQ=DAILY", `SUMMARY:Imported ${n}`, "END:VEVENT"].join("\r\n"));
const importInput = { userId, userZone: "UTC", ownAddresses: [], color: "#16a34a", reminders: true, skipDeclined: true, groups: importGroups };
const firstImport = await importCalendarGroups(db, importInput);
check("calendar import inserts", firstImport.imported === 9 && firstImport.failed === 0);
const secondImport = await importCalendarGroups(db, importInput);
check("calendar import is idempotent", secondImport.imported === 0 && secondImport.skipped === 9);
const importedRows = await db.select({ id: calendarEvents.id, repeat: calendarEvents.repeat, mailboxId: calendarEvents.mailboxId }).from(calendarEvents).where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.title, "Imported 3")));
check("imported event is a plain daily series", importedRows.length === 1 && importedRows[0].repeat === "daily" && importedRows[0].mailboxId === null && importedRows[0].id.startsWith("ics_"));
// CalDAV/CardDAV change log: the dav_changes_* triggers must agree on every dialect (MySQL compares text case-insensitively unless told otherwise).
const davEventId = `evt_${stamp}`;
const davLog = async (collection: string, key: string) => (await db.all<{ change_type: string }>(sql`SELECT change_type FROM dav_changes WHERE collection_id = ${collection} AND object_key = ${key} ORDER BY seq`)).map((row) => row.change_type).join(",");
await db.insert(calendarEvents).values({ id: davEventId, userId, title: "Standup", startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) } as never);
check("dav trigger logs an inserted event", (await davLog(`cal:${userId}`, davEventId)) === "created");
await db.update(calendarEvents).set({ title: "standup" }).where(eq(calendarEvents.id, davEventId));
check("dav trigger sees a case-only title change", (await davLog(`cal:${userId}`, davEventId)) === "created,updated");
await db.update(calendarEvents).set({ lastRemindedStart: new Date() }).where(eq(calendarEvents.id, davEventId));
await db.update(calendarEvents).set({ title: "standup" }).where(eq(calendarEvents.id, davEventId));
check("dav trigger ignores reminder bookkeeping and no-op updates", (await davLog(`cal:${userId}`, davEventId)) === "created,updated");
// F6-2: an override row is part of its parent's DAV resource, and a master and its override leave no stray change after the master is destroyed.
const davOverrideId = `${davEventId}_o`;
const davBase = { userId, title: "Series", startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) };
await db.insert(calendarEvents).values({ ...davBase, id: davEventId + "_m", davObjectId: davEventId + "_m", rrule: "FREQ=WEEKLY;INTERVAL=2", repeat: "custom" } as never);
await db.insert(calendarEvents).values({ ...davBase, id: davOverrideId, davObjectId: davEventId + "_m", recurrenceId: new Date(Date.now() + 3_600_000) } as never);
check("dav trigger keys an override row under its parent", (await davLog(`cal:${userId}`, davEventId + "_m")) === "created,updated" && (await davLog(`cal:${userId}`, davOverrideId)) === "");
await db.update(calendarEvents).set({ allDay: true }).where(eq(calendarEvents.id, davOverrideId));
check("dav trigger watches the new calendar columns", (await davLog(`cal:${userId}`, davEventId + "_m")) === "created,updated,updated");
await db.delete(calendarEvents).where(eq(calendarEvents.id, davOverrideId));
check("dav trigger reports a deleted override as an update of its parent", (await davLog(`cal:${userId}`, davEventId + "_m")) === "created,updated,updated,updated");
await db.delete(calendarEvents).where(eq(calendarEvents.id, davEventId + "_m"));
check("dav trigger destroys a deleted master", (await davLog(`cal:${userId}`, davEventId + "_m")).endsWith(",destroyed"));
// F9 8.2: an event in another calendar is logged under that calendar's collection, and moving it destroys it in the old one.
const calId = `cal:cal_${stamp}`;
const calEventId = `evt_cal_${stamp}`;
await db.insert(davCollections).values({ id: calId, userId, kind: "calendar" } as never);
await db.insert(calendarEvents).values({ id: calEventId, userId, calendarId: calId, title: "Work", startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) } as never);
check("dav trigger logs an event in another calendar under its collection", (await davLog(calId, calEventId)) === "created" && (await davLog(`cal:${userId}`, calEventId)) === "");
await db.update(calendarEvents).set({ isPrivate: true }).where(eq(calendarEvents.id, calEventId));
await db.update(calendarEvents).set({ transparent: true }).where(eq(calendarEvents.id, calEventId));
check("dav trigger watches is_private and transparent", (await davLog(calId, calEventId)) === "created,updated,updated");
await db.update(calendarEvents).set({ calendarId: null }).where(eq(calendarEvents.id, calEventId));
check("dav trigger moves an event between calendars", (await davLog(calId, calEventId)) === "created,updated,updated,destroyed" && (await davLog(`cal:${userId}`, calEventId)) === "created");
await db.update(calendarEvents).set({ calendarId: calId }).where(eq(calendarEvents.id, calEventId));
await db.delete(calendarEvents).where(eq(calendarEvents.calendarId, calId));
check("dav trigger logs a calendar's events deleted by statement", (await davLog(calId, calEventId)).endsWith(",destroyed"));
// CS-2: a master and its override rows move together in one statement; the old collection sees the master destroyed once, the new one created once.
const moveCalId = `cal:cal_move_${stamp}`;
const moveMasterId = `evt_mv_${stamp}`;
await db.insert(davCollections).values({ id: moveCalId, userId, kind: "calendar" } as never);
const moveTimes = { startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) };
await db.insert(calendarEvents).values({ id: moveMasterId, userId, title: "Series", davObjectId: moveMasterId, ...moveTimes } as never);
await db.insert(calendarEvents).values({ id: `${moveMasterId}_o`, userId, title: "Moved occurrence", davObjectId: moveMasterId, recurrenceId: moveTimes.startsAt, ...moveTimes } as never);
await db.update(calendarEvents).set({ calendarId: moveCalId }).where(and(eq(calendarEvents.userId, userId), sql`(${calendarEvents.id} = ${moveMasterId} OR ${calendarEvents.davObjectId} = ${moveMasterId})`));
check("moving a master and its overrides in one statement logs one move", (await davLog(moveCalId, moveMasterId)).split(",").sort().join(",") === "created,updated" && (await davLog(`cal:${userId}`, moveMasterId)).endsWith(",destroyed") && (await davLog(`cal:${userId}`, moveMasterId)).split("destroyed").length === 2);
await db.delete(calendarEvents).where(eq(calendarEvents.calendarId, moveCalId));
await db.delete(davCollections).where(eq(davCollections.id, moveCalId));
// CS-2: a batch that writes into a calendar whose row is gone fails as a whole, and one into a calendar that exists goes through.
const guardCalId = `cal:cal_guard_${stamp}`;
const guardedInsert = (id: string) => db.batch([...calendarExistsGuard(db, userId, guardCalId), db.insert(calendarEvents).values({ id, userId, calendarId: guardCalId, title: "Guarded", ...moveTimes } as never)] as never);
let calGuardRefused = false;
try { await guardedInsert(`evt_g1_${stamp}`); } catch { calGuardRefused = true; }
const [{ guardedrows }] = await db.all<{ guardedrows: number }>(sql`SELECT count(*) AS guardedrows FROM calendar_events WHERE id = ${`evt_g1_${stamp}`}`);
check("the calendar guard refuses a write into a calendar that is gone", calGuardRefused && Number(guardedrows) === 0);
await db.insert(davCollections).values({ id: guardCalId, userId, kind: "calendar" } as never);
await guardedInsert(`evt_g2_${stamp}`);
const [{ guardrows }] = await db.all<{ guardrows: number }>(sql`SELECT count(*) AS guardrows FROM dav_sync_state WHERE epoch = 'guard'`);
check("the calendar guard lets a write into an existing calendar through and leaves no guard rows", Number(guardrows) === 0 && (await davLog(guardCalId, `evt_g2_${stamp}`)) === "created");
await db.delete(calendarEvents).where(eq(calendarEvents.calendarId, guardCalId));
await db.delete(davCollections).where(eq(davCollections.id, guardCalId));
// The sync report orders by `seq + 0` (not the rowid order) so the collection index serves it; the expression must be valid and ordered on every dialect.
const orderedSeqs = (await db.select({ seq: davChanges.seq }).from(davChanges).orderBy(sql`${davChanges.seq} + 0`).limit(20)).map((row) => Number(row.seq));
check("the change log can be ordered by seq + 0", orderedSeqs.length > 1 && orderedSeqs.every((seq, index) => index === 0 || seq > orderedSeqs[index - 1]));
// CS-3: roles, the role-change batch, redacted reads and revoke work the same on every dialect.
const sharee = `usr_sh_${stamp}`;
const shareeEmail = `sh${stamp}@example.com`;
await db.insert(users).values({ id: sharee, email: shareeEmail, passwordHash: "x", name: "Sharee" });
const sharedCal = `cal:cal_sh_${stamp}`;
await db.insert(davCollections).values({ id: sharedCal, userId, kind: "calendar", displayName: "Shared" } as never);
await db.insert(calendarEvents).values({ id: `evt_sh_${stamp}`, userId, calendarId: sharedCal, title: "Plan", location: "Room 1", isPrivate: true, startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) } as never);
const readRange = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 3 * 86_400_000) };
const sharedDb = db as never;
const granted = await grantShare(sharedDb, { id: userId }, sharedCal, { email: shareeEmail.toUpperCase(), role: "read" });
check("a calendar is shared with an account by address, and only that account gets the role", granted.ok && (await getCalendarRole(sharedDb, { id: sharee }, sharedCal)) === "read" && (await getCalendarRole(sharedDb, { id: `usr_none_${stamp}` }, sharedCal)) === null);
check("the sharee lists the calendar, with the owner's name", (await listVisibleCalendars(sharedDb, { id: sharee })).some((entry) => entry.id === sharedCal && entry.role === "read" && entry.ownerName === "A"));
const readerView = await listVisibleEvents(sharedDb, { id: sharee }, readRange, []);
check("a reader gets a private event as Busy with no location", readerView.length === 1 && readerView[0].title === "Busy" && readerView[0].location === "" && readerView[0].role === "read");
const regranted = granted.ok ? await changeShare(sharedDb, { id: userId }, sharedCal, { id: granted.share.id, role: "edit" }) : null;
const [{ grantRows }] = await db.all<{ grantRows: number }>(sql`SELECT count(*) AS "grantRows" FROM calendar_shares WHERE calendar_id = ${sharedCal}`);
check("a role change replaces the grant under a new id", !!regranted?.ok && granted.ok && regranted.share.id !== granted.share.id && regranted.share.role === "edit" && Number(grantRows) === 1);
check("an editor sees the private event whole", (await listVisibleEvents(sharedDb, { id: sharee }, readRange, [sharedCal]))[0]?.title === "Plan");
for (const scope of calendarScopes(Array.from({ length: 130 }, (_, index) => ({ id: `cal:smoke_${index}`, ownerId: userId })))) await db.select({ id: calendarEvents.id }).from(calendarEvents).where(scope).limit(1);
check("130 shared calendars read in chunked statements", calendarScopes(Array.from({ length: 130 }, (_, index) => ({ id: `cal:smoke_${index}`, ownerId: userId }))).length === 4);
const revoked = regranted?.ok ? await revokeShare(sharedDb, { id: userId }, sharedCal, regranted.share.id) : null;
check("revoking removes the role at once", !!revoked?.ok && (await getCalendarRole(sharedDb, { id: sharee }, sharedCal)) === null && (await listVisibleEvents(sharedDb, { id: sharee }, readRange, [sharedCal])).length === 0);
await db.delete(calendarEvents).where(eq(calendarEvents.calendarId, sharedCal));
await db.delete(davCollections).where(eq(davCollections.id, sharedCal));
const shareId = `csh_${stamp}`;
await db.insert(calendarShares).values({ id: shareId, calendarId: calId, granteeUserId: userId, role: "read" } as never);
await db.insert(calendarResources).values({ id: `res_${stamp}`, name: `Room ${stamp}` } as never);
await db.insert(calendarEvents).values({ id: `evt_room_${stamp}`, userId, title: "Booked", startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) } as never);
await db.insert(calendarResourceBookings).values({ id: `crb_${stamp}`, resourceId: `res_${stamp}`, eventId: `evt_room_${stamp}`, status: "accepted" } as never);
await db.delete(davCollections).where(eq(davCollections.id, calId));
const [{ shares }] = await db.all<{ shares: number }>(sql`SELECT count(*) AS shares FROM calendar_shares WHERE id = ${shareId}`);
check("deleting a calendar removes its grants", Number(shares) === 0);
await db.delete(calendarEvents).where(eq(calendarEvents.id, `evt_room_${stamp}`));
const [{ bookings }] = await db.all<{ bookings: number }>(sql`SELECT count(*) AS bookings FROM calendar_resource_bookings WHERE id = ${`crb_${stamp}`}`);
check("deleting an event removes its room booking", Number(bookings) === 0);
await db.delete(calendarResources).where(eq(calendarResources.id, `res_${stamp}`));
// Rooms: two saves for one slot at once end with one accepted (the compare-and-swap token), and the room's busy time is the winner's.
await db.insert(calendarResources).values({ id: `res2_${stamp}`, name: `Room2 ${stamp}` } as never);
const roomSlot = new Date(Date.now() + 3 * 86_400_000);
for (const name of ["a", "b"]) await db.insert(calendarEvents).values({ id: `evt_${name}_${stamp}`, userId, title: "Race", startsAt: roomSlot, endsAt: new Date(roomSlot.getTime() + 3_600_000) } as never);
// Two separate connections, so a real server (PostgreSQL, MySQL) races for real. An in-memory database exists only on its own connection, and SQLite is a
// single-writer file the app opens once (a second connection in one process only finds "database is locked"), so those share one.
const secondDb = /memory/i.test(url) || config.dialect === "sqlite" ? db : createDb(openExternalDatabase(config, false) as unknown as D1Database);
const raced = await Promise.all([bookRooms(db as never, `evt_a_${stamp}`, [`res2_${stamp}`]), bookRooms(secondDb as never, `evt_b_${stamp}`, [`res2_${stamp}`])]);
check("two bookings of one room slot at once leave exactly one accepted", raced.map((result) => result.rooms[0].status).sort().join() === "accepted,declined");
const [{ accepted_rooms }] = await db.all<{ accepted_rooms: number }>(sql`SELECT count(*) AS accepted_rooms FROM calendar_resource_bookings WHERE resource_id = ${`res2_${stamp}`} AND status = 'accepted'`);
check("exactly one accepted booking row is stored", Number(accepted_rooms) === 1);
const roomBusy = await busyIntervals(env, { userIds: [], resourceIds: [`res2_${stamp}`] }, new Date(roomSlot.getTime() - 3_600_000), new Date(roomSlot.getTime() + 7_200_000));
check("the room is busy for the accepted booking only", roomBusy.get(`res2_${stamp}`)?.length === 1 && roomBusy.get(`res2_${stamp}`)![0][0] === Math.floor(roomSlot.getTime() / 1000) * 1000);
await db.delete(calendarEvents).where(inArray(calendarEvents.id, [`evt_a_${stamp}`, `evt_b_${stamp}`]));
const freed = await busyIntervals(env, { userIds: [], resourceIds: [`res2_${stamp}`] }, new Date(roomSlot.getTime() - 3_600_000), new Date(roomSlot.getTime() + 7_200_000));
check("deleting the events frees the room", freed.get(`res2_${stamp}`)?.length === 0);
await db.delete(calendarResources).where(eq(calendarResources.id, `res2_${stamp}`));
await db.insert(davCollections).values({ id: `card:${userId}`, userId, kind: "addressbook" } as never);
await db.insert(davCards).values({ id: `card_${stamp}`, userId, collectionId: `card:${userId}`, name: "a.vcf", uid: "uid-1", body: "BEGIN:VCARD", version: "3.0", size: 11 } as never);
await db.update(davCards).set({ body: "BEGIN:VCARD\nEND:VCARD" }).where(eq(davCards.id, `card_${stamp}`));
check("dav trigger logs card create and update", (await davLog(`card:${userId}`, `card_${stamp}`)) === "created,updated");
await db.update(davCards).set({ body: "BEGIN:VCARD\nEND:VCARD" }).where(eq(davCards.id, `card_${stamp}`));
check("dav trigger ignores a card update that changes nothing", (await davLog(`card:${userId}`, `card_${stamp}`)) === "created,updated");
await db.update(davCards).set({ collectionId: `card:${userId}-moved` }).where(eq(davCards.id, `card_${stamp}`));
check("dav trigger logs a card moved between collections", (await davLog(`card:${userId}`, `card_${stamp}`)) === "created,updated,destroyed" && (await davLog(`card:${userId}-moved`, `card_${stamp}`)) === "created");

const contactBody = { mailboxId: `mbx_${stamp}`, format: "vcard" as const, items: [
	{ vcard: "BEGIN:VCARD\nVERSION:3.0\nFN:Smoke Person\nEMAIL:smoke-a@example.com\nEMAIL:smoke-b@example.com\nTEL:+1 555 0100\nORG:Acme\nEND:VCARD", hasPhoto: true },
	{ vcard: "BEGIN:VCARD\nVERSION:3.0\nFN:No Mail\nEND:VCARD", hasPhoto: false },
] };
const firstContacts = await importContacts(db, { userId, body: contactBody });
check("contact import inserts one contact per address", firstContacts.created === 2 && firstContacts.noEmail === 1 && firstContacts.photoTargets.join() === "smoke-a@example.com");
const secondContacts = await importContacts(db, { userId, body: contactBody });
check("contact import is idempotent", secondContacts.created === 0 && secondContacts.updated === 0 && secondContacts.unchanged === 2);
const importedContact = await db.select({ name: contacts.displayName, source: contacts.source, details: contactDetails.details }).from(contacts).innerJoin(contactDetails, eq(contactDetails.contactId, contacts.id)).where(eq(contacts.id, `${userId}:smoke-b@example.com`));
check("imported contact keeps its details", importedContact.length === 1 && importedContact[0].name === "Smoke Person" && importedContact[0].source === "import" && JSON.parse(importedContact[0].details).organization === "Acme");
await db.delete(contacts).where(eq(contacts.id, `${userId}:smoke-a@example.com`));
check("deleting a contact removes its details", (await db.select().from(contactDetails).where(eq(contactDetails.contactId, `${userId}:smoke-a@example.com`))).length === 0);
const ownPhoto = await importContacts(db, { userId, body: { mailboxId: `mbx_${stamp}`, format: "vcard", items: [{ vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:Me\nEMAIL:me@${stamp}.example.com\nEND:VCARD`, hasPhoto: true }] } });
check("an own identity address is never a photo target", ownPhoto.created === 1 && ownPhoto.photoTargets.length === 0);

await recordReputationObservation(env, `mbx_${stamp}`, [{ type: "domain", key: "example.com" }, { type: "email", key: "x@y.z" }] as never);
await recordReputationObservation(env, `mbx_${stamp}`, [{ type: "domain", key: "example.com" }] as never);
const reputation = await db.select().from(spamReputation).where(and(eq(spamReputation.mailboxId, `mbx_${stamp}`), eq(spamReputation.key, "example.com")));
check("spam reputation upsert", reputation[0]?.messagesSeen === 2);

const suppressed = { domainId: `dom_${stamp}`, email: "a@x.org" };
await recordSuppression(env, { ...suppressed, reason: "manual", source: "admin", detail: "note" });
await recordSuppression(env, { ...suppressed, reason: "hard_bounce", source: "ses", detail: "550" });
await recordSuppression(env, { ...suppressed, reason: "complaint", source: "resend" });
await recordSuppression(env, { ...suppressed, reason: "hard_bounce", source: "ses", detail: "again" });
const [suppression] = await db.select().from(emailSuppressions).where(eq(emailSuppressions.domainId, suppressed.domainId));
check("suppression upsert keeps the strongest reason and counts events", suppression?.reason === "complaint" && suppression.source === "resend" && suppression.eventCount === 4);

const returned = { domainId: `dom_${stamp}`, email: "dsn@x.org", reason: "hard_bounce" as const, source: "dsn" as const, confirmed: false };
const confirmedOf = async () => (await db.select().from(emailSuppressions).where(and(eq(emailSuppressions.domainId, returned.domainId), eq(emailSuppressions.email, returned.email))))[0]?.confirmed;
await recordSuppression(env, { ...returned, evidenceRef: "m1" });
await recordSuppression(env, { ...returned, evidenceRef: "m1" });
const sameMessage = await confirmedOf();
await recordSuppression(env, { ...returned, evidenceRef: "m2" });
check("a DSN is confirmed only by a second, different original message", sameMessage === false && await confirmedOf() === true);

// DMARC report ingest: report row, aggregate upserts in batches, and the stats queries, on this dialect.
const reportDay = Math.floor(Date.now() / 1000) - 3600;
const reportXml = (reportId: string) => `<feedback><report_metadata><org_name>google.com</org_name><email>r@google.com</email><report_id>${reportId}</report_id><date_range><begin>${reportDay}</begin><end>${reportDay + 3600}</end></date_range></report_metadata><policy_published><domain>smoke.test</domain><p>none</p><pct>100</pct></policy_published><record><row><source_ip>203.0.113.7</source_ip><count>40</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>smoke.test</header_from></identifiers></record><record><row><source_ip>198.51.100.9</source_ip><count>2</count><policy_evaluated><disposition>reject</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row><identifiers><header_from>smoke.test</header_from></identifiers></record></feedback>`;
const reportMime = (reportId: string) => Buffer.from(`From: r@google.com\r\nTo: mailflare-reports@smoke.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: application/gzip\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="r.xml.gz"\r\n\r\n${Buffer.from(gzipSync(reportXml(reportId))).toString("base64")}\r\n--b--\r\n`);
const reportObjects = new Map<string, Buffer>();
const reportEnv = { DB: d1, BUCKET: { get: async (key: string) => { const bytes = reportObjects.get(key); return bytes ? { size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer } : null; }, delete: async (key: string) => { reportObjects.delete(key); } } } as unknown as CloudflareEnv;
const reportTarget = { domainId: `dom_${stamp}`, hostname: "smoke.test" };
for (const [key, id] of [["raw1", `r1_${stamp}`], ["raw2", `r2_${stamp}`], ["raw1", `r1_${stamp}`]] as const) {
	reportObjects.set(key, reportMime(id));
	await ingestReportMail(reportEnv, reportTarget, { rawR2Key: key, authenticated: true, from: "r@google.com" }, { lookupPtr: async () => null });
}
const dmarc = await getDmarcStats(reportEnv, reportTarget.domainId, { days: 7 });
const dmarcTotal = (key: "pass" | "rejected") => dmarc.series.reduce((sum, day) => sum + day[key], 0);
check("dmarc ingest adds counts across reports and ignores a redelivery", dmarcTotal("pass") === 80 && dmarcTotal("rejected") === 4 && dmarc.sources.length === 2 && dmarc.reporters[0]?.reports === 2);

// TLS-RPT ingest: same path, the upsert adds integer counts, a redelivery changes nothing.
const tlsJson = (reportId: string) => JSON.stringify({ "organization-name": "Google Inc.", "date-range": { "start-datetime": new Date(reportDay * 1000).toISOString(), "end-datetime": new Date((reportDay + 3600) * 1000).toISOString() }, "contact-info": "smtp-tls-reporting@google.com", "report-id": reportId, policies: [{ policy: { "policy-type": "sts", "policy-domain": "smoke.test", "mx-host": ["mx.smoke.test"] }, summary: { "total-successful-session-count": 10, "total-failure-session-count": 2 }, "failure-details": [{ "result-type": "certificate-expired", "failed-session-count": 2 }] }] });
const tlsMime = (reportId: string) => Buffer.from(`From: smtp-tls-reporting@google.com\r\nTo: mailflare-reports@smoke.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: application/tlsrpt+gzip\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="r.json.gz"\r\n\r\n${Buffer.from(gzipSync(tlsJson(reportId))).toString("base64")}\r\n--b--\r\n`);
for (const [key, id] of [["tls1", `t1_${stamp}`], ["tls2", `t2_${stamp}`], ["tls1", `t1_${stamp}`]] as const) {
	reportObjects.set(key, tlsMime(id));
	await ingestReportMail(reportEnv, reportTarget, { rawR2Key: key, authenticated: true, from: "smtp-tls-reporting@google.com" }, { lookupPtr: async () => null });
}
const tls = await getTlsStats(reportEnv, reportTarget.domainId, { days: 7 });
check("tls-rpt ingest adds counts across reports and ignores a redelivery", tls.series.reduce((sum, day) => sum + day.success, 0) === 20 && tls.series.reduce((sum, day) => sum + day.failure, 0) === 4 && tls.failureTypes[0]?.resultType === "certificate-expired" && tls.failureTypes[0].failure === 4 && tls.recentReports.length === 2);
check("dmarc stats ignore tls-rpt reports", (await getDmarcStats(reportEnv, reportTarget.domainId, { days: 7 })).recentReports.every((report) => report.reporterOrg === "google.com") && dmarcTotal("pass") === 80);

// MTA-STS: publish, serve through the host-keyed join, mark checked, then the removal period and the daily retirement.
const stsDomain = { id: `dom_${stamp}`, hostname: `${stamp}.example.com`, zoneId: "z" };
let stsRecord: string | null = null;
const stsDeps: MtaStsDeps = {
	listTxt: async () => (stsRecord ? [{ id: "r1", content: stsRecord }] : []),
	queryTxt: async () => (stsRecord ? [stsRecord] : []),
	createTxt: async (_env, _zone, _name, content) => { stsRecord = content; },
	updateTxt: async (_env, _zone, _id, content) => { stsRecord = content; },
	deleteTxt: async () => { stsRecord = null; },
	ensureRoute: async () => undefined,
	deleteRoute: async () => undefined,
	queryMx: async () => ["10 route1.mx.cloudflare.net."],
	zoneMx: async () => ["10 route1.mx.cloudflare.net."],
};
const published = await updateMtaSts(reportEnv, stsDomain, { mode: "testing" }, stsDeps);
const policyRequest = () => new Request(`https://mta-sts.${stsDomain.hostname}/.well-known/mta-sts.txt`);
const served = await serveMtaStsPolicy(reportEnv, policyRequest());
check("mta-sts publishes and serves the stored policy", published.kind === "ok" && served.status === 200 && (await served.text()).includes("mx: route1.mx.cloudflare.net") && String(stsRecord).startsWith("v=STSv1; id="));
const checked = await markMtaStsVerified(reportEnv, stsDomain);
check("mta-sts records the browser check", checked.kind === "ok" && checked.state.verifiedAt !== null);
const enforced = await updateMtaSts(reportEnv, stsDomain, { mode: "enforce", acknowledgeRisk: true }, stsDeps, new Date(Date.now() + 2000));
check("mta-sts switches to enforce with a new id", enforced.kind === "ok" && published.kind === "ok" && enforced.state.mode === "enforce" && enforced.state.policyId !== published.state.policyId);
const changedMx = await updateMtaSts(reportEnv, stsDomain, { mode: "enforce", acknowledgeRisk: true }, { ...stsDeps, queryMx: async () => ["10 other.smoke.test."] }, new Date(Date.now() + 3000));
check("mta-sts refuses a changed MX list while enforce", changedMx.kind === "error" && changedMx.code === "MX_CHANGED_IN_ENFORCE");
const blockedMx = await assertMxChangeAllowed(reportEnv, stsDomain).then(() => null, (error: unknown) => (error as { code?: string }).code);
const blockedDelete = await assertDomainRemovable(reportEnv, stsDomain, stsDeps).then(() => null, (error: unknown) => (error as { code?: string }).code);
check("mta-sts blocks MX changes in enforce and domain deletion while published", blockedMx === "MTA_STS_ENFORCED" && blockedDelete === "MTA_STS_PUBLISHED");
const retiring = await updateMtaSts(reportEnv, stsDomain, { mode: "none" }, stsDeps, new Date(Date.now() + 4000));
check("mta-sts removal serves mode none", retiring.kind === "ok" && retiring.state.status === "retiring" && (await (await serveMtaStsPolicy(reportEnv, policyRequest())).text()).includes("mode: none"));

await db.insert(domainDeliverability).values({ domainId: reportTarget.domainId, reportsEnabled: true, reportsEnabledAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
await runDeliverabilityDaily(reportEnv, new Date(), { sendMail: async () => true, mtaStsDeps: stsDeps });
check("mta-sts is still served before the removal period ends", (await serveMtaStsPolicy(reportEnv, policyRequest())).status === 200);
await runDeliverabilityDaily(reportEnv, new Date(Date.now() + 200 * 86_400_000), { sendMail: async () => true, mtaStsDeps: stsDeps });
check("mta-sts retires after the removal period: record deleted, host answers 404", (stsRecord as string | null) === null && (await serveMtaStsPolicy(reportEnv, policyRequest())).status === 404);
const leftover = await db.all<{ n: number }>(sql`SELECT (SELECT count(*) FROM dmarc_daily_stats WHERE domain_id = ${reportTarget.domainId}) + (SELECT count(*) FROM tls_daily_stats WHERE domain_id = ${reportTarget.domainId}) + (SELECT count(*) FROM deliverability_reports WHERE domain_id = ${reportTarget.domainId}) AS n`);
check("deliverability daily job purges data past retention", Number(leftover[0].n) === 0);

try {
	await db.insert(users).values({ id: `usr2_${stamp}`, email: `a${stamp}@example.com`, passwordHash: "x", name: "B" });
	check("unique violation throws", false);
} catch (error) {
	check("unique violation is recognised", isUniqueConstraintError(error));
}

const searchStatus = await getSearchIndexStatus(env);
check("search index status", searchStatus.messages === searchStatus.indexed && searchStatus.messages >= 1);

// Promotions: the grouped Subscriptions query (group by, count distinct, sum(case), batched latest-message selects)
// and the backfill (claim, keyset select, batched updates, fenced save) in this dialect.
const promo = { id: `pro_${stamp}`, base: { userId, mailboxId: `mbx_${stamp}`, direction: "inbound", toAddr: "me@example.com", status: "received" } };
await db.insert(messages).values([
	{ ...promo.base, id: `${promo.id}_1`, fromAddr: "Acme <news@acme.com>", senderAddress: "news@acme.com", category: "promotions", hasUnsubscribe: true, read: true },
	{ ...promo.base, id: `${promo.id}_2`, fromAddr: "Acme <news@acme.com>", senderAddress: "news@acme.com", category: "promotions", hasUnsubscribe: true },
	{ ...promo.base, id: `${promo.id}_3`, fromAddr: "Shop <deals@shop.com>", senderAddress: "deals@shop.com", category: "promotions" },
	{ ...promo.base, id: `${promo.id}_4`, fromAddr: "Late <late@news.com>", hasUnsubscribe: true, rawR2Key: `raw/${promo.id}_4` },
] as never);
const subscriptions = await listSubscriptions(db, { mailboxId: `mbx_${stamp}`, offset: 0, limit: 50 });
check("subscriptions grouped query", subscriptions.total === 2 && subscriptions.senders[0]?.senderAddress === "news@acme.com" && subscriptions.senders[0].total === 2 && subscriptions.senders[0].readRate === 50 && subscriptions.senders[0].canUnsubscribe && subscriptions.senders[0].lastReceived instanceof Date && subscriptions.senders[1]?.latestMessageId === `${promo.id}_3`);
await db.insert(mailboxPromotionSettings).values({ mailboxId: `mbx_${stamp}`, mode: "show", backfillStatus: "pending" } as never);
const candidates = await selectBackfillCandidates(db, { mailboxId: `mbx_${stamp}`, cursor: null, now: new Date() });
check("backfill candidate select", candidates.length === 1 && candidates[0].id === `${promo.id}_4`);
const bucket = { get: async () => ({ arrayBuffer: async () => new TextEncoder().encode("List-Unsubscribe: <mailto:u@late.com>\r\n\r\nbody").buffer }) };
const backfilled = await runPromotionsBackfill({ DB: d1, BUCKET: bucket } as unknown as CloudflareEnv, new Date());
const [late] = await db.select({ category: messages.category, senderAddress: messages.senderAddress }).from(messages).where(eq(messages.id, `${promo.id}_4`));
const [progress] = await db.select().from(mailboxPromotionSettings).where(eq(mailboxPromotionSettings.mailboxId, `mbx_${stamp}`));
check("backfill claims, classifies and saves", backfilled.claimed && late.category === "promotions" && late.senderAddress === "late@news.com" && progress.backfillStatus === "done" && progress.backfillScanned === 1 && progress.backfillStalls === 0);

// An aggregate row that exists when the backup is taken: dmarc_daily_stats has a serial id that must not be backed up.
reportObjects.set("raw4", reportMime(`r4_${stamp}`));
await ingestReportMail(reportEnv, reportTarget, { rawR2Key: "raw4", authenticated: true, from: "r@google.com" }, { lookupPtr: async () => null });
const backup = await exportDatabaseRecords(d1);
const exported = JSON.parse(new TextDecoder().decode(backup)) as { tables: Record<string, Array<Record<string, unknown>>> };
check("backup leaves out the serial id of dmarc_daily_stats", exported.tables.dmarc_daily_stats.length >= 2 && exported.tables.dmarc_daily_stats.every((row) => !("id" in row)));
check("backup exports portable values", exported.tables.users.every((row) => typeof row.disabled === "number") && exported.tables.messages.length >= 1);
await restoreDatabaseRecords(d1, backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength) as ArrayBuffer);
const [afterRestore] = await db.select({ subject: messages.subject, starred: messages.starred, createdAt: messages.createdAt }).from(messages).where(eq(messages.id, `msg_${stamp}`));
check("backup restores", afterRestore?.subject === "Quarterly Report" && afterRestore.starred === false && afterRestore.createdAt instanceof Date);

const davAfterRestore = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM dav_cards WHERE id = ${`card_${stamp}`}`);
check("backup restores dav cards and collections", Number(davAfterRestore[0].n) === 1 && exported.tables.dav_cards.length === 1 && exported.tables.dav_collections.length === 1 && !("dav_changes" in exported.tables));
// F6-5: a destroyed DAV resource keeps the name it was served under (the cascade removes dav_calendar_objects with the event).
const davNameOf = async (collection: string, key: string) => (await db.all<{ resource_name: string | null }>(sql`SELECT resource_name FROM dav_changes WHERE collection_id = ${collection} AND object_key = ${key} AND change_type = 'destroyed'`)).map((row) => row.resource_name).join(",");
const namedId = `evt_${stamp}_named`;
await db.insert(calendarEvents).values({ id: namedId, userId, title: "Phone made", startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000), davObjectId: namedId } as never);
await db.insert(davCalendarObjects).values({ id: namedId, userId, collectionId: `cal:${userId}`, name: "phone-made.ics", uid: `uid-${stamp}`, size: 1 } as never);
await db.delete(calendarEvents).where(eq(calendarEvents.id, namedId));
check("dav trigger records the name of a destroyed DAV event", (await davNameOf(`cal:${userId}`, namedId)) === "phone-made.ics");
await db.delete(davCards).where(eq(davCards.id, `card_${stamp}`));
check("dav trigger records the name of a destroyed card", (await davNameOf(`card:${userId}-moved`, `card_${stamp}`)) === "a.vcf");
// F6-5: the write guard fails a whole batch when the resource is no longer as it was read, on every dialect, and leaves no rows behind.
const guardId = `evt_${stamp}_guard`;
const guardCollection = `cal:${userId}`;
await db.insert(calendarEvents).values({ id: guardId, userId, title: "Guard", startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) } as never);
const guardSeq = Number((await db.all<{ seq: number }>(sql`SELECT max(seq) AS seq FROM dav_changes WHERE collection_id = ${guardCollection} AND object_key = ${guardId}`))[0].seq);
const guarded = (title: string) => db.batch([...staleGuard(db, calendarEvents, [guardCollection], guardId, userId, { seq: guardSeq, updatedAt: new Date() }), db.update(calendarEvents).set({ title }).where(eq(calendarEvents.id, guardId))] as never);
const guardTitle = async () => (await db.select({ title: calendarEvents.title }).from(calendarEvents).where(eq(calendarEvents.id, guardId)))[0].title;
await guarded("First writer");
check("dav write guard lets a batch through while the resource is as it was read", (await guardTitle()) === "First writer");
let guardRefused = false;
try {
	await guarded("Second writer");
} catch (error) {
	guardRefused = isUniqueConstraintError(error);
}
check("dav write guard fails the whole batch once the resource changed", guardRefused && (await guardTitle()) === "First writer");
const guardRows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM dav_sync_state WHERE collection_id LIKE 'guard:%'`);
check("dav write guard leaves no rows behind", Number(guardRows[0].n) === 0);
// CS-4: a web move batch keeps the stored CalDAV resource in the collection the event is in, on every dialect.
const objectCollection = async () => (await db.select({ collectionId: davCalendarObjects.collectionId }).from(davCalendarObjects).where(eq(davCalendarObjects.id, guardId)))[0]?.collectionId;
await db.insert(davCalendarObjects).values({ id: guardId, userId, collectionId: guardCollection, name: `${guardId}.ics`, uid: `${guardId}@smoke`, size: 1 } as never);
await db.batch(moveSeriesStatements(db, userId, guardId, moveCalId) as never);
const movedTo = await objectCollection();
await db.batch(moveSeriesStatements(db, userId, guardId, null) as never);
check("a move batch carries the stored resource to the new collection and back", movedTo === moveCalId && (await objectCollection()) === guardCollection);
await db.delete(davCalendarObjects).where(eq(davCalendarObjects.id, guardId));
// CS-4: the grant guard refuses a batch while its condition holds and lets it through otherwise.
const requireWrite = (missing: ReturnType<typeof sql>) => db.batch([...requireGuard(db, missing), db.update(calendarEvents).set({ title: "Required" }).where(eq(calendarEvents.id, guardId))] as never);
await requireWrite(sql`not exists (select 1 from users where id = ${userId})`);
const passedRequire = (await guardTitle()) === "Required";
let requireRefused = false;
try { await requireWrite(sql`not exists (select 1 from users where id = ${`nobody_${stamp}`})`); } catch (error) { requireRefused = isUniqueConstraintError(error); }
const requireRows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM dav_sync_state WHERE collection_id LIKE 'guard:%'`);
check("the require guard passes when nothing is missing, refuses when it is, and leaves no rows", passedRequire && requireRefused && Number(requireRows[0].n) === 0);
// CS-4: sync positions of many collections come from a few statements; a calendar epoch from before per-calendar logs is renewed (version 8), others are kept.
const staleCal = `cal:cal_epoch_${stamp}`;
await db.insert(davSyncState).values({ collectionId: staleCal, epoch: crypto.randomUUID(), floor: 0 } as never);
const positions = await syncPositions(env, [guardCollection, staleCal, `cal:cal_fresh_${stamp}`, `card:${userId}`]);
check("syncPositions reads the newest change of each collection and creates missing state", positions.get(guardCollection)!.seq === guardSeq || positions.get(guardCollection)!.seq > guardSeq);
check("calendar sync epochs are renewed to version 8 once, card epochs are untouched", positions.get(staleCal)!.epoch[14] === "8" && positions.get(`cal:cal_fresh_${stamp}`)!.epoch[14] === "8" && positions.get(`card:${userId}`)!.epoch[14] === "4" && (await syncPositions(env, [staleCal])).get(staleCal)!.epoch === positions.get(staleCal)!.epoch);
await db.delete(davSyncState).where(inArray(davSyncState.collectionId, [staleCal, `cal:cal_fresh_${stamp}`, `card:${userId}`]));
await db.delete(calendarEvents).where(eq(calendarEvents.id, davEventId));
check("dav trigger logs a deleted event", (await davLog(`cal:${userId}`, davEventId)).endsWith("destroyed"));
reportObjects.set("raw5", reportMime(`r5_${stamp}`));
await ingestReportMail(reportEnv, reportTarget, { rawR2Key: "raw5", authenticated: true, from: "r@google.com" }, { lookupPtr: async () => null });
const afterRestoreStats = await getDmarcStats(reportEnv, reportTarget.domainId, { days: 7 });
check("dmarc ingest keeps working after a restore (sequence not behind the rows)", afterRestoreStats.series.reduce((sum, day) => sum + day.pass, 0) === 80);

// F6-6: a card mirrors into contacts in one batch: upsert with the first-link-wins name rule, promotion to manual, unlink of removed addresses.
const mirrorOf = (email: string) => db.select({ name: contacts.displayName, source: contacts.source, card: contacts.davCardId, blocked: contacts.blocked }).from(contacts).where(and(eq(contacts.userId, userId), eq(contacts.email, email))).then((rows) => rows[0]);
await db.insert(contacts).values({ id: `${userId}:old@example.com`, userId, email: "old@example.com", displayName: "Heard", source: "inbound", blocked: true } as never);
await db.batch(mirrorCardStatements(db, userId, { id: "card_a", fn: "Card A", emails: ["old@example.com", "both@example.com"], group: false, own: new Set<string>() }) as never);
await db.batch(mirrorCardStatements(db, userId, { id: "card_b", fn: "Card B", emails: ["both@example.com", "only-b@example.com"], group: false, own: new Set<string>() }) as never);
const [mirrorOld, mirrorBoth, mirrorOnlyB] = [await mirrorOf("old@example.com"), await mirrorOf("both@example.com"), await mirrorOf("only-b@example.com")];
check("card mirror promotes and links a contact without touching blocked", mirrorOld?.source === "manual" && mirrorOld.name === "Card A" && mirrorOld.card === "card_a" && mirrorOld.blocked === true);
check("card mirror: the first card to link an address keeps it and its name", mirrorBoth?.card === "card_a" && mirrorBoth.name === "Card A" && mirrorOnlyB?.card === "card_b" && mirrorOnlyB.name === "Card B");
await db.batch(mirrorCardStatements(db, userId, { id: "card_a", fn: "Card A", emails: ["both@example.com"], group: false, own: new Set<string>() }) as never);
check("card mirror unlinks an address taken off its card and keeps the contact", (await mirrorOf("old@example.com"))?.card === null && (await mirrorOf("old@example.com"))?.source === "manual");

// F6-6: seeding copies unlinked manual contacts into cards in one batch (multi-row insert plus one CASE update) and finishes the address book.
await db.insert(contacts).values([{ id: `${userId}:seed1@example.com`, userId, email: "seed1@example.com", displayName: "Seed One", source: "manual" }, { id: `${userId}:seed2@example.com`, userId, email: "seed2@example.com", source: "manual" }] as never);
await db.insert(davCollections).values({ id: `card:${userId}`, userId, kind: "addressbook" } as never).onConflictDoNothing();
// An address already on some card gets no second card (the LIKE over the card's JSON addresses, with the UID list in one OR).
await db.insert(contacts).values({ id: `${userId}:seed3@example.com`, userId, email: "seed3@example.com", source: "manual" } as never);
await db.insert(davCards).values({ id: "card_listed", userId, collectionId: `card:${userId}`, name: "listed.vcf", uid: "listed", body: "x", version: "3.0", fn: "Listed", emails: JSON.stringify(["seed3@example.com"]), size: 1 } as never);
const seeded = await seedStep(env, userId);
const seedLinks = await db.select({ email: contacts.email, card: contacts.davCardId }).from(contacts).where(and(eq(contacts.userId, userId), sql`${contacts.email} like 'seed%'`));
const seedCards = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM dav_cards WHERE user_id = ${userId} AND uid LIKE 'mf-%'`);
const seedDone = await db.all<{ at: number | null }>(sql`SELECT seeded_at AS at FROM dav_collections WHERE id = ${`card:${userId}`}`);
check("contact seeding links each manual contact to its own card and finishes", seeded === "done" && seedLinks.filter((row) => row.card).length === 2 && seedLinks.filter((row) => row.card).every((row) => row.card?.startsWith("card_")) && Number(seedCards[0].n) >= 2 && seedDone[0].at !== null);
check("contact seeding skips an address that is already on a card", seedLinks.find((row) => row.email === "seed3@example.com")?.card === null);

// Free/busy (CS-5): busy intervals, address resolution, access by grant, and the org switch column on every dialect.
const fbUser = `usr_fb_${stamp}`;
const fbCal = `cal:fb_${stamp}`;
const fbDay = new Date(Math.ceil(Date.now() / 86_400_000) * 86_400_000 + 86_400_000);
await db.insert(users).values({ id: fbUser, email: `fb${stamp}@example.com`, passwordHash: "x", name: "Fb" });
await db.insert(calendarEvents).values([
	{ id: `evt_fb1_${stamp}`, userId: fbUser, title: "Weekly", startsAt: new Date(fbDay.getTime() + 9 * 3_600_000), endsAt: new Date(fbDay.getTime() + 10 * 3_600_000), repeat: "weekly", isPrivate: true },
	{ id: `evt_fb3_${stamp}`, userId: fbUser, title: "Daily", startsAt: new Date(fbDay.getTime() + 20 * 3_600_000), endsAt: new Date(fbDay.getTime() + 21 * 3_600_000), repeat: "daily", repeatUntil: new Date(fbDay.getTime() + 5 * 86_400_000) },
	// Began before the window and ended (repeat_until) before it, but its last occurrence, 22:00 the evening before, runs on until 02:00: only repeat_until + duration reaches the window.
	{ id: `evt_fb4_${stamp}`, userId: fbUser, title: "Ended", startsAt: new Date(fbDay.getTime() - 3 * 86_400_000 + 22 * 3_600_000), endsAt: new Date(fbDay.getTime() - 3 * 86_400_000 + 26 * 3_600_000), repeat: "daily", repeatUntil: new Date(fbDay.getTime() - 3_600_000) },
	{ id: `evt_fb2_${stamp}`, userId: fbUser, title: "Free", startsAt: new Date(fbDay.getTime() + 12 * 3_600_000), endsAt: new Date(fbDay.getTime() + 13 * 3_600_000), transparent: true },
] as never);
const fbBusy = await busyIntervals(env, { userIds: [fbUser, userId] }, fbDay, new Date(fbDay.getTime() + 15 * 86_400_000));
check("free/busy expands a private weekly series and a daily one that ends, and skips a free event", fbBusy.get(fbUser)?.length === 9 && fbBusy.get(fbUser)![1][0] === fbDay.getTime() + 9 * 3_600_000 && fbBusy.get(userId)?.length !== undefined);
check("free/busy keeps the last occurrence of a series that ended before the window but runs into it", fbBusy.get(fbUser)![0][0] === fbDay.getTime() && fbBusy.get(fbUser)![0][1] === fbDay.getTime() + 2 * 3_600_000);
const fbResolved = await resolveFreeBusyAddresses(env, [`FB${stamp}@example.com`, "nobody@example.com"]);
check("free/busy resolves an address regardless of case and drops unknown ones", fbResolved.get(`fb${stamp}@example.com`) === fbUser && fbResolved.size === 1);
check("free/busy: a stranger sees nobody, and org free/busy is off without the switch", (await viewableFreeBusyUsers(env, userId, [fbUser])).size === 0 && (await isOrgFreeBusyEnabled(env)) === false);
await db.insert(davCollections).values({ id: fbCal, userId: fbUser, kind: "calendar", displayName: "Fb" } as never);
await db.insert(calendarShares).values({ id: `csh_fb_${stamp}`, calendarId: fbCal, granteeUserId: userId, role: "freebusy" } as never);
check("free/busy: any grant on the owner's calendar opens it", (await viewableFreeBusyUsers(env, userId, [fbUser])).has(fbUser));
await db.insert(appSettings).values({ id: "default", calendarOrgFreeBusy: true } as never).onConflictDoUpdate({ target: appSettings.id, set: { calendarOrgFreeBusy: true } });
const [orgOn] = await db.select({ on: appSettings.calendarOrgFreeBusy }).from(appSettings).where(eq(appSettings.id, "default"));
check("app_settings.calendar_org_free_busy stores a boolean, and without Team the switch still counts as off", orgOn?.on === true && (await isOrgFreeBusyEnabled(env)) === false);
await db.update(appSettings).set({ calendarOrgFreeBusy: false }).where(eq(appSettings.id, "default"));
await db.delete(davCollections).where(eq(davCollections.id, fbCal));
await db.delete(users).where(eq(users.id, fbUser));

const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, "default"));
check("seed rows present", settings?.appName === "Mailflare");

await db.delete(users).where(eq(users.id, userId));
const remaining = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM messages WHERE user_id = ${userId}`);
check("cascade delete", Number(remaining[0].n) === 0);

await external.sqlExecutor.close?.();
const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
