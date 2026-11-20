/**
 * Exercises the database layer against any DATABASE_URL: migrations, the query shapes the app relies on
 * (insert/select/update, returning, onConflict*, raw sql, batch), the triggers and search.
 * Run with `npm run db:smoke -- <DATABASE_URL> [driver]`; PGlite needs no server (`pglite://memory`).
 */
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "@/db";
import { users, contacts, domains, mailboxes, messages, folders, jmapChanges, calendarEvents, davCalendarObjects, davCards, davCollections, appSettings, webhooks, spamTokenStats, spamReputation } from "@/db/schema";
import { getDatabaseConfig } from "@/db/with-database";
import { openExternalDatabase } from "@/db/external";
import { staleGuard } from "@/lib/dav/writes";
import { mirrorCardStatements } from "@/lib/dav/contact-mirror";
import { seedStep } from "@/lib/dav/contact-seed";
import { applyPendingMigrations, getMigrationStatus } from "@/lib/migrations/service";
import { buildSearchConditions } from "@/lib/search/conditions";
import { createBookedCalendarEvents } from "@/lib/booking/create";
import { exportDatabaseRecords, restoreDatabaseRecords } from "@/lib/backups/export";
import { getSearchIndexStatus } from "@/lib/search/index-admin";
import { recordReputationObservation } from "@/lib/spam/repository";
import { isUniqueConstraintError } from "@/lib/database-errors";

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
await db.insert(davCollections).values({ id: `card:${userId}`, userId, kind: "addressbook" } as never);
await db.insert(davCards).values({ id: `card_${stamp}`, userId, collectionId: `card:${userId}`, name: "a.vcf", uid: "uid-1", body: "BEGIN:VCARD", version: "3.0", size: 11 } as never);
await db.update(davCards).set({ body: "BEGIN:VCARD\nEND:VCARD" }).where(eq(davCards.id, `card_${stamp}`));
check("dav trigger logs card create and update", (await davLog(`card:${userId}`, `card_${stamp}`)) === "created,updated");
await db.update(davCards).set({ body: "BEGIN:VCARD\nEND:VCARD" }).where(eq(davCards.id, `card_${stamp}`));
check("dav trigger ignores a card update that changes nothing", (await davLog(`card:${userId}`, `card_${stamp}`)) === "created,updated");
await db.update(davCards).set({ collectionId: `card:${userId}-moved` }).where(eq(davCards.id, `card_${stamp}`));
check("dav trigger logs a card moved between collections", (await davLog(`card:${userId}`, `card_${stamp}`)) === "created,updated,destroyed" && (await davLog(`card:${userId}-moved`, `card_${stamp}`)) === "created");

await recordReputationObservation(env, `mbx_${stamp}`, [{ type: "domain", key: "example.com" }, { type: "email", key: "x@y.z" }] as never);
await recordReputationObservation(env, `mbx_${stamp}`, [{ type: "domain", key: "example.com" }] as never);
const reputation = await db.select().from(spamReputation).where(and(eq(spamReputation.mailboxId, `mbx_${stamp}`), eq(spamReputation.key, "example.com")));
check("spam reputation upsert", reputation[0]?.messagesSeen === 2);

try {
	await db.insert(users).values({ id: `usr2_${stamp}`, email: `a${stamp}@example.com`, passwordHash: "x", name: "B" });
	check("unique violation throws", false);
} catch (error) {
	check("unique violation is recognised", isUniqueConstraintError(error));
}

const searchStatus = await getSearchIndexStatus(env);
check("search index status", searchStatus.messages === searchStatus.indexed && searchStatus.messages >= 1);

const backup = await exportDatabaseRecords(d1);
const exported = JSON.parse(new TextDecoder().decode(backup)) as { tables: Record<string, Array<Record<string, unknown>>> };
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
const guarded = (title: string) => db.batch([...staleGuard(db, calendarEvents, guardCollection, guardId, userId, { seq: guardSeq, updatedAt: new Date() }), db.update(calendarEvents).set({ title }).where(eq(calendarEvents.id, guardId))] as never);
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
await db.delete(calendarEvents).where(eq(calendarEvents.id, davEventId));
check("dav trigger logs a deleted event", (await davLog(`cal:${userId}`, davEventId)).endsWith("destroyed"));

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

const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, "default"));
check("seed rows present", settings?.appName === "Mailflare");

await db.delete(users).where(eq(users.id, userId));
const remaining = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM messages WHERE user_id = ${userId}`);
check("cascade delete", Number(remaining[0].n) === 0);

await external.sqlExecutor.close?.();
const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
