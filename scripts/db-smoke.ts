/**
 * Exercises the database layer against any DATABASE_URL: migrations, the query shapes the app relies on
 * (insert/select/update, returning, onConflict*, raw sql, batch), the triggers and search.
 * Run with `npm run db:smoke -- <DATABASE_URL> [driver]`; PGlite needs no server (`pglite://memory`).
 */
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "@/db";
import { users, domains, mailboxes, messages, calendarEvents, contacts, contactDetails, folders, jmapChanges, appSettings, webhooks, spamTokenStats, spamReputation } from "@/db/schema";
import { getDatabaseConfig } from "@/db/with-database";
import { openExternalDatabase } from "@/db/external";
import { applyPendingMigrations, getMigrationStatus } from "@/lib/migrations/service";
import { buildSearchConditions } from "@/lib/search/conditions";
import { createBookedCalendarEvents } from "@/lib/booking/create";
import { importCalendarGroups } from "@/lib/calendar/import-store";
import { importContacts } from "@/lib/contacts/import-store";
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

const importGroups = Array.from({ length: 9 }, (_, n) => ["BEGIN:VEVENT", `UID:smoke-${n}@google.com`, "DTSTART:20261104T090000Z", "RRULE:FREQ=DAILY", `SUMMARY:Imported ${n}`, "END:VEVENT"].join("\r\n"));
const importInput = { userId, userZone: "UTC", ownAddresses: [], color: "#16a34a", reminders: true, skipDeclined: true, groups: importGroups };
const firstImport = await importCalendarGroups(db, importInput);
check("calendar import inserts", firstImport.imported === 9 && firstImport.failed === 0);
const secondImport = await importCalendarGroups(db, importInput);
check("calendar import is idempotent", secondImport.imported === 0 && secondImport.skipped === 9);
const importedRows = await db.select({ id: calendarEvents.id, repeat: calendarEvents.repeat, mailboxId: calendarEvents.mailboxId }).from(calendarEvents).where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.title, "Imported 3")));
check("imported event is a plain daily series", importedRows.length === 1 && importedRows[0].repeat === "daily" && importedRows[0].mailboxId === null && importedRows[0].id.startsWith("ics_"));

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

const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, "default"));
check("seed rows present", settings?.appName === "Mailflare");

await db.delete(users).where(eq(users.id, userId));
const remaining = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM messages WHERE user_id = ${userId}`);
check("cascade delete", Number(remaining[0].n) === 0);

await external.sqlExecutor.close?.();
const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
