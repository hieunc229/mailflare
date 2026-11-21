/**
 * Exercises the database layer against any DATABASE_URL: migrations, the query shapes the app relies on
 * (insert/select/update, returning, onConflict*, raw sql, batch), the triggers and search.
 * Run with `npm run db:smoke -- <DATABASE_URL> [driver]`; PGlite needs no server (`pglite://memory`).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { createDb } from "@/db";
import { users, domains, mailboxes, messages, folders, jmapChanges, appSettings, webhooks, spamTokenStats, spamReputation, imapMessageFlags } from "@/db/schema";
import { getDatabaseConfig } from "@/db/with-database";
import { openExternalDatabase } from "@/db/external";
import { applyPendingMigrations, getMigrationStatus } from "@/lib/migrations/service";
import { buildSearchConditions } from "@/lib/search/conditions";
import { createBookedCalendarEvents } from "@/lib/booking/create";
import { exportDatabaseRecords, restoreDatabaseRecords } from "@/lib/backups/export";
import { getSearchIndexStatus } from "@/lib/search/index-admin";
import { recordReputationObservation } from "@/lib/spam/repository";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { syncMailbox } from "@/lib/imap/sync";
import { pruneImapExpunged } from "@/lib/imap/expunge-prune";
import { changedSince, maxModseqOf, modseqsOf, vanishedSince } from "@/lib/imap/condstore";
import { unchangedSinceLogged } from "@/lib/jmap/emails";
import { FolderView } from "@/lib/imap/view";

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

// IMAP state: the sync engine's own query shapes (conditional counter update, anti-join reconcile, multi-row insert, batch).
const imapMailbox = `mbx_${stamp}`;
await syncMailbox(env, imapMailbox);
const imapUids = () => db.all<{ uid: number; message_id: string; folder_key: string }>(sql`SELECT uid, message_id, folder_key FROM imap_uids WHERE mailbox_id = ${imapMailbox} ORDER BY folder_key, uid`);
check("imap reconcile assigns a UID (anti-join, multi-row insert)", (await imapUids()).length === 1 && Number((await imapUids())[0].uid) === 1 && (await imapUids())[0].folder_key === "inbox");
const [folderCounters] = await db.all<{ uid_next: number; modseq: number }>(sql`SELECT f.uid_next AS uid_next, m.modseq AS modseq FROM imap_folder_state f JOIN imap_mailbox_state m ON m.mailbox_id = f.mailbox_id WHERE f.id = ${`${imapMailbox}:inbox`}`);
check("imap counters are reserved in the batch that uses them (derived UID and modseq)", Number(folderCounters.uid_next) === 2 && Number(folderCounters.modseq) >= 2);
await db.update(messages).set({ status: "archived" }).where(eq(messages.id, `msg_${stamp}`));
await syncMailbox(env, imapMailbox);
const movedUids = await imapUids();
const expungedRows = await db.all<{ uid: number }>(sql`SELECT uid FROM imap_expunged WHERE mailbox_id = ${imapMailbox} AND folder_key = 'inbox'`);
check("imap move expunges and assigns a new UID (change-log sync)", movedUids.length === 1 && movedUids[0].folder_key === "archive" && expungedRows.length === 1);
await db.run(sql`DELETE FROM imap_mailbox_state WHERE mailbox_id = ${imapMailbox}`);
await syncMailbox(env, imapMailbox);
check("imap reconcile is idempotent", (await imapUids()).length === 1);
await db.update(messages).set({ status: "received" }).where(eq(messages.id, `msg_${stamp}`));

// IMAP writes: the flag upsert with the message touch (one batch), the expunge candidate join, the unflag update, the UID lookup and the conditional move and delete.
const flagsMessage = `msg_${stamp}`;
await syncMailbox(env, imapMailbox);
const [beforeFlags] = await db.all<{ modseq: number }>(sql`SELECT modseq FROM imap_uids WHERE mailbox_id = ${imapMailbox} AND message_id = ${flagsMessage}`);
const flagValues = { answered: true, forwarded: false, deleted: true, keywords: '["Orders"]', updatedAt: Math.floor(Date.now() / 1000) };
await db.batch([
	db.insert(imapMessageFlags).values({ messageId: flagsMessage, ...flagValues }).onConflictDoUpdate({ target: imapMessageFlags.messageId, set: flagValues }),
	db.update(messages).set({ read: sql`${messages.read}` }).where(and(eq(messages.id, flagsMessage), eq(messages.mailboxId, imapMailbox))),
] as never);
await syncMailbox(env, imapMailbox);
const [afterFlags] = await db.all<{ modseq: number }>(sql`SELECT modseq FROM imap_uids WHERE mailbox_id = ${imapMailbox} AND message_id = ${flagsMessage}`);
check("imap flag write gives the UID a later mod-sequence (upsert plus touch)", Number(afterFlags.modseq) > Number(beforeFlags.modseq));
const candidates = (await d1.prepare("SELECT u.uid AS uid, u.message_id AS message_id FROM imap_uids u INNER JOIN imap_message_flags f ON f.message_id = u.message_id WHERE u.mailbox_id = ? AND u.folder_key = ? AND f.deleted = ? ORDER BY u.uid LIMIT ?").bind(imapMailbox, "inbox", true, 10).all<{ uid: number; message_id: string }>()).results;
check("imap expunge candidates (join on the \\Deleted flag)", candidates.length === 1 && candidates[0].message_id === flagsMessage);
await d1.prepare("UPDATE imap_message_flags SET deleted = ? WHERE message_id IN (?, ?)").bind(false, flagsMessage, "none").run();
const [unflagged] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM imap_message_flags WHERE message_id = ${flagsMessage} AND NOT deleted`);
check("imap unflag update", Number(unflagged.n) === 1);
const looked = (await d1.prepare("SELECT message_id, uid FROM imap_uids WHERE mailbox_id = ? AND folder_key = ? AND message_id IN (?, ?)").bind(imapMailbox, "inbox", flagsMessage, "none").all<{ message_id: string; uid: number }>()).results;
check("imap UID lookup by message ids", looked.length === 1 && Number(looked[0].uid) >= 1);
await db.run(sql`DELETE FROM imap_message_flags WHERE message_id = ${flagsMessage}`);
const guarded = `msg_guard_${stamp}`;
await db.insert(messages).values({ id: guarded, userId, mailboxId: imapMailbox, direction: "inbound", fromAddr: "x@y.z", toAddr: "me@example.com", subject: "Guarded", textBody: "body", status: "trash" } as never);
const movedWrong = await db.update(messages).set({ status: "trash", folderId: null }).where(and(eq(messages.id, guarded), eq(messages.mailboxId, imapMailbox), eq(messages.status, "archived"), isNull(messages.folderId))).returning({ id: messages.id });
const deletedWrong = await db.delete(messages).where(and(eq(messages.id, guarded), eq(messages.mailboxId, imapMailbox), eq(messages.status, "archived"), isNull(messages.folderId))).returning({ id: messages.id });
check("imap conditional move and delete skip a row that changed", movedWrong.length === 0 && deletedWrong.length === 0);
const movedRight = await db.update(messages).set({ status: "archived", folderId: null }).where(and(eq(messages.id, guarded), eq(messages.mailboxId, imapMailbox), eq(messages.status, "trash"), isNull(messages.folderId))).returning({ id: messages.id });
const deletedRight = await db.delete(messages).where(and(eq(messages.id, guarded), eq(messages.mailboxId, imapMailbox), eq(messages.status, "archived"), isNull(messages.folderId))).returning({ id: messages.id });
check("imap conditional move and delete return the rows they changed", movedRight.length === 1 && deletedRight.length === 1);

// IMAP STORE UNCHANGEDSINCE: the write is conditional on the change log, in the statement that writes.
const logged = `msg_log_${stamp}`;
await db.insert(messages).values({ id: logged, userId, mailboxId: imapMailbox, direction: "inbound", fromAddr: "x@y.z", toAddr: "me@example.com", subject: "Logged", textBody: "body", status: "received" } as never);
const [logTop] = await db.all<{ top: number }>(sql`SELECT max(seq) AS top FROM jmap_changes WHERE mailbox_id = ${imapMailbox}`);
const loggedGuard = { mailboxId: imapMailbox, jmapSeq: Number(logTop.top) };
const writtenFirst = await db.update(messages).set({ starred: true }).where(and(eq(messages.id, logged), unchangedSinceLogged(loggedGuard, logged))).returning({ id: messages.id });
const writtenAgain = await db.update(messages).set({ starred: false }).where(and(eq(messages.id, logged), unchangedSinceLogged(loggedGuard, logged))).returning({ id: messages.id });
const [loggedRow] = await db.select({ starred: messages.starred }).from(messages).where(eq(messages.id, logged));
check("imap conditional update on the change log writes when nothing is newer and skips once something is", writtenFirst.length === 1 && writtenAgain.length === 0 && loggedRow.starred === true);
await db.delete(messages).where(eq(messages.id, logged));
await syncMailbox(env, imapMailbox);

// IMAP CONDSTORE and QRESYNC: the mod-sequence reads, the expunge log prune (state lock, floor update and delete in one batch, old rows read through the age index) and the vanished-UID answer on both sides of the floor.
const inboxView = await FolderView.open(env, imapMailbox, "inbox");
const inboxChanged = await changedSince(env, imapMailbox, "inbox", 0);
const inboxModseqs = await modseqsOf(env, imapMailbox, "inbox", [...inboxChanged]);
check("imap mod-sequence reads (by UID list, maximum in SQL, changed since) agree", inboxChanged.size >= 1 && inboxModseqs.size === inboxChanged.size && (await maxModseqOf(env, imapMailbox, "inbox", [...inboxChanged])) === Math.max(...inboxModseqs.values()));
const [loggedExpunges] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM imap_expunged WHERE mailbox_id = ${imapMailbox} AND folder_key = 'inbox'`);
const vanishedFromLog = await vanishedSince(env, inboxView, 0, null);
await db.run(sql`UPDATE imap_expunged SET created_at = 1 WHERE mailbox_id = ${imapMailbox}`);
const pruned = await pruneImapExpunged(env, new Date());
const [floorRow] = await db.all<{ expunged_floor: number }>(sql`SELECT expunged_floor FROM imap_folder_state WHERE id = ${`${imapMailbox}:inbox`}`);
const [logLeft] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM imap_expunged WHERE mailbox_id = ${imapMailbox}`);
check("imap prune drops the old expunge rows and records the floor", pruned >= Number(loggedExpunges.n) && Number(logLeft.n) === 0 && Number(floorRow.expunged_floor) > 0);
const vanishedFromUids = await vanishedSince(env, inboxView, 0, null);
check("imap vanished UIDs are the same from the log and from the UIDs that exist", vanishedFromLog.length > 0 && JSON.stringify(vanishedFromLog) === JSON.stringify(vanishedFromUids));

await db.run(sql`INSERT INTO imap_message_flags (message_id, answered, keywords) VALUES (${`msg_${stamp}`}, ${true}, ${'["$label1"]'})`);
const backup = await exportDatabaseRecords(d1);
const exported = JSON.parse(new TextDecoder().decode(backup)) as { tables: Record<string, Array<Record<string, unknown>>> };
check("backup exports portable values", exported.tables.users.every((row) => typeof row.disabled === "number") && exported.tables.messages.length >= 1);
await restoreDatabaseRecords(d1, backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength) as ArrayBuffer);
const [afterRestore] = await db.select({ subject: messages.subject, starred: messages.starred, createdAt: messages.createdAt }).from(messages).where(eq(messages.id, `msg_${stamp}`));
check("backup restores", afterRestore?.subject === "Quarterly Report" && afterRestore.starred === false && afterRestore.createdAt instanceof Date);
const [imapLeft] = await db.all<{ n: number }>(sql`SELECT (SELECT count(*) FROM imap_uids) + (SELECT count(*) FROM imap_expunged) + (SELECT count(*) FROM imap_mailbox_state) + (SELECT count(*) FROM imap_folder_state WHERE uid_next <> 1 OR highest_modseq > 1) AS n`);
check("restore clears the derived IMAP state tables", Number(imapLeft.n) === 0);
const [validity] = await db.all<{ uidvalidity: number; highest_modseq: number }>(sql`SELECT uidvalidity, highest_modseq FROM imap_folder_state WHERE id = ${`${imapMailbox}:archive`}`);
check("restore keeps UIDVALIDITY above its old value", Number(validity?.uidvalidity) > 1_000_000_000);
check("restore re-seeds a folder with HIGHESTMODSEQ 1, never 0", Number(validity?.highest_modseq) === 1);
const [flags] = await db.all<{ answered: unknown; keywords: string }>(sql`SELECT answered, keywords FROM imap_message_flags WHERE message_id = ${`msg_${stamp}`}`);
check("imap_message_flags are backed up and restored", Boolean(flags) && Number(flags.answered) === 1 || flags?.answered === true);

const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, "default"));
check("seed rows present", settings?.appName === "Mailflare");

await db.delete(users).where(eq(users.id, userId));
const remaining = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM messages WHERE user_id = ${userId}`);
check("cascade delete", Number(remaining[0].n) === 0);

await external.sqlExecutor.close?.();
const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
