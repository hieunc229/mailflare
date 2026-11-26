import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * These tests drive the real HTTP handlers (bulk actions, folder retention PATCH, the import service) against
 * a migrated SQLite database and the Node runtime's file-backed bucket, the way the app runs them. They exist
 * because the guards under test defend against what those flows do to a message after it was filed — status
 * rewrites, draft provenance, live outbound jobs, and moves/clears that race the scheduled purge.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-folder-retention-flows-"));
after(() => {
	rmSync(outDir, { recursive: true, force: true });
	delete globalThis.__mailflareNodeEnv;
});

await build({
	stdin: {
		resolveDir: root,
		sourcefile: "folder-retention-flows-entry.ts",
		contents: `
			export * from './server/runtime/sqlite-database';
			export * from './server/runtime/file-bucket';
			export * from './src/lib/email/raw-sweeper';
			export * from './src/lib/email/send';
			export * from './src/lib/email/trash-retention';
			export * from './src/lib/import/service';
			export * from './src/lib/auth/session';
			export * as retentionRoute from './src/app/api/folders/[id]/retention/route';
			export * as bulkRoute from './src/app/api/messages/bulk/route';
			export * as trashSettingsRoute from './src/app/api/settings/trash-retention/route';
		`,
	},
	outfile: join(outDir, "bundle.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["drizzle-orm", "drizzle-orm/*", "better-sqlite3", "postal-mime"],
	plugins: [{
		name: "worker-environment",
		setup(plugin) {
			plugin.onResolve({ filter: /^next\/(server|headers)$/ }, (args) => ({ path: `${args.path}.js`, external: true }));
			plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "worker", namespace: "stub" }));
			plugin.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const env = {};" }));
		},
	}],
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
	logLevel: "silent",
});

const m = await import(pathToFileURL(join(outDir, "bundle.mjs")).href);
const { runTrashRetention, sweepOrphanedRawMail, sendEmail, sendScheduledMessageNow, importMessagesToMailbox, createSession, retentionRoute, bulkRoute, trashSettingsRoute, SqliteDatabase, openFileBucket } = m;

const DAY = 86_400_000;
const NOW = new Date();
let providerMessages = 0;
const daysAgo = (days) => Math.floor((NOW.getTime() - days * DAY) / 1000);

/** Migrated SQLite + real file bucket, two accounts, a shared mailbox with a folder and a bearer session each. */
async function fixture(t) {
	const scratch = mkdtempSync(join(outDir, "run-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const database = new SqliteDatabase(join(scratch, "mailflare.sqlite"));
	t.after(() => database.db.close());
	const { migrations } = JSON.parse((await import("node:fs")).readFileSync(join(root, "src/lib/migrations/bundle.json"), "utf8"));
	for (const migration of migrations) await database.batch(migration.statements.map((statement) => database.prepare(statement)));

	const db = database.db;
	const bucket = openFileBucket(join(scratch, "bucket"));
	const env = { DB: database, BUCKET: bucket };
	globalThis.__mailflareNodeEnv = env;

	const run = (sql, ...args) => db.prepare(sql).run(...args);
	const created = daysAgo(400);
	run("INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'f29-flows', 'team', 'active', 1)");
	run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('a', 'a@example.test', 'A', 'x', ?), ('b', 'b@example.test', 'B', 'x', ?)", created, created);
	run("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('da', 'a', 'a.test', 'z', ?), ('db', 'b', 'b.test', 'z', ?)", created, created);
	run("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('a1', 'a', 'da', 'a', 'shared', ?), ('b1', 'b', 'db', 'b', 'personal', ?)", created, created);
	run("INSERT INTO folders (id, user_id, mailbox_id, name, retention_days, created_at) VALUES ('news', 'a', 'a1', 'News', 7, ?), ('plain', 'a', 'a1', 'Plain', NULL, ?)", created, created);
	run("UPDATE domains SET sending_enabled = 1, sending_provider = 'cloudflare' WHERE id = 'da'");
	env.EMAIL = { send: async () => ({ messageId: `<provider-${++providerMessages}@a.test>` }) };
	env.OUTBOUND_QUEUE = { send: async () => {} };
	// b is a delegate on a's shared mailbox.
	run("INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('grant', 'a1', 'b', 'full_access', ?)", created);

	const message = (id, { userId = "a", mailboxId = "a1", folderId = null, status = "received", direction = "inbound", created: createdAt = daysAgo(90), privateDraft = false, rawR2Key = null } = {}) => {
		run("INSERT INTO messages (id, user_id, mailbox_id, folder_id, direction, from_addr, to_addr, status, private_draft, created_at, raw_r2_key) VALUES (?, ?, ?, ?, ?, 'sender@example.test', 'a@example.test', ?, ?, ?, ?)", id, userId, mailboxId, folderId, direction, status, privateDraft ? 1 : 0, createdAt, rawR2Key);
	};
	const messageRow = (id) => db.prepare("SELECT id, folder_id, status, private_draft, raw_r2_key FROM messages WHERE id = ?").get(id);

	const request = (method, token, body) => new Request("http://mailflare.test/", {
		method,
		headers: token ? { Authorization: `Bearer ${token}` } : {},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const sessions = { a: await createSession(env, "a"), b: await createSession(env, "b") };
	const bulk = (token, payload) => bulkRoute.POST(request("POST", token, payload));
	const setRule = (token, folderId, days) => retentionRoute.PATCH(request("PATCH", token, { days }), { params: Promise.resolve({ id: folderId }) });
	const setTrashRule = (token, days) => trashSettingsRoute.PATCH(request("PATCH", token, { days }));

	const send = async (subject) => (await sendEmail(env, {
		userId: "a",
		mailboxId: "a1",
		from: "a@a.test",
		to: "someone@example.test",
		subject,
		text: "hello",
		scheduledAt: new Date(Date.now() + DAY).toISOString(),
	})).messageId;

	return { env, db, database, bucket, run, message, messageRow, bulk, setRule, setTrashRule, send, sessions };
}

/**
 * Wrap the database so the first attachment-key read pauses: the callback runs before that read is executed,
 * which is the window between the key capture and the conditional DELETE.
 */
function pausingDatabase(database, onKeyRead) {
	let paused = false;
	return new Proxy(database, {
		get(target, property) {
			if (property !== "prepare") {
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			}
			return (sql) => {
				const statement = target.prepare(sql);
				if (paused || !/from "message_attachments"/.test(sql)) return statement;
				return new Proxy(statement, {
					get(statementTarget, statementProperty) {
						const statementValue = Reflect.get(statementTarget, statementProperty, statementTarget);
						if (statementProperty !== "bind") return typeof statementValue === "function" ? statementValue.bind(statementTarget) : statementValue;
						return (...args) => {
							const bound = statementTarget.bind(...args);
							return new Proxy(bound, {
								get(boundTarget, boundProperty) {
									const boundValue = Reflect.get(boundTarget, boundProperty, boundTarget);
									if (typeof boundValue !== "function") return boundValue;
									if (!["raw", "all", "run"].includes(boundProperty)) return boundValue.bind(boundTarget);
									return async (...callArgs) => {
										if (!paused) {
											paused = true;
											await onKeyRead(args);
										}
										return boundValue.apply(boundTarget, callArgs);
									};
								},
							});
						};
					},
				});
			};
		},
	});
}

test("a queued message moved into a ruled folder keeps its live send", async (t) => {
	const f = await fixture(t);
	f.message("queued-mail", { status: "queued", direction: "outbound" });
	f.run("INSERT INTO outbound_jobs (id, user_id, message_id, status, payload, created_at, updated_at) VALUES ('job', 'a', 'queued-mail', 'sending', '{}', ?, ?)", daysAgo(300), daysAgo(300));
	// The real bulk route rewrites `queued` to `received` when filing.
	assert.equal((await f.bulk(f.sessions.a, { messageIds: ["queued-mail"], action: "folder", folderId: "news" })).status, 200);
	assert.deepEqual(f.messageRow("queued-mail"), { id: "queued-mail", folder_id: "news", status: "received", private_draft: 0, raw_r2_key: null });

	assert.equal(await runTrashRetention(f.env, NOW), 0, "the folder rule must not destroy a message a live send still owns");
	assert.equal(f.messageRow("queued-mail")?.id, "queued-mail");
	assert.deepEqual(
		f.db.prepare("SELECT message_id, status FROM outbound_jobs WHERE id = 'job'").get(),
		{ message_id: "queued-mail", status: "sending" },
		"the live job still points at its message",
	);
});

test("an unsent draft archived then moved into a ruled folder survives", async (t) => {
	const f = await fixture(t);
	f.message("draft-mail", { status: "draft", direction: "outbound", privateDraft: true });
	assert.equal((await f.bulk(f.sessions.a, { messageIds: ["draft-mail"], action: "archive" })).status, 200);
	assert.equal((await f.bulk(f.sessions.a, { messageIds: ["draft-mail"], action: "folder", folderId: "news" })).status, 200);
	assert.equal(f.messageRow("draft-mail").private_draft, 1, "archive-then-move keeps the draft provenance");

	assert.equal(await runTrashRetention(f.env, NOW), 0);
	assert.equal(f.messageRow("draft-mail")?.id, "draft-mail");
});

test("sent mail filed in a ruled folder is out of scope, and an unknown status stays put", async (t) => {
	const f = await fixture(t);
	f.message("sent-mail", { status: "sent", direction: "outbound", folderId: "news" });
	f.message("unknown-mail", { status: "future_unknown", folderId: "news" });
	assert.equal(await runTrashRetention(f.env, NOW), 0);
	assert.deepEqual(f.db.prepare("SELECT id FROM messages ORDER BY id").all().map((row) => row.id), ["sent-mail", "unknown-mail"]);
});

test("a message moved out of a ruled folder during the run keeps its row and its objects", async (t) => {
	const f = await fixture(t);
	f.message("race-01", { folderId: "news", rawR2Key: "first.eml" });
	f.message("race-02", { folderId: "news", rawR2Key: "second.eml" });
	await f.bucket.put("first.eml", "first");
	await f.bucket.put("second.eml", "second");

	const movingEnv = {
		...f.env,
		BUCKET: {
			...f.bucket,
			delete: async (key) => {
				if (String(key) === "first.eml") {
					// The real route, mid-run: the second candidate leaves the ruled folder before it is reached.
					assert.equal((await f.bulk(f.sessions.a, { messageIds: ["race-02"], action: "folder", folderId: "plain" })).status, 200);
					assert.equal(f.messageRow("race-02").folder_id, "plain");
				}
				return f.bucket.delete(key);
			},
		},
	};

	assert.equal(await runTrashRetention(movingEnv, NOW), 1, "only the message that was still filed is deleted");
	assert.equal(f.messageRow("race-01"), undefined);
	assert.equal(f.messageRow("race-02")?.folder_id, "plain");
	assert.ok(await f.bucket.head("second.eml"), "the moved message keeps its raw object");
	assert.equal(await f.bucket.head("first.eml"), null);
});

test("clearing the rule during the run spares the candidates not yet reached", async (t) => {
	const f = await fixture(t);
	f.message("clear-01", { folderId: "news", rawR2Key: "clear-first.eml" });
	f.message("clear-02", { folderId: "news", rawR2Key: "clear-second.eml" });
	await f.bucket.put("clear-first.eml", "first");
	await f.bucket.put("clear-second.eml", "second");

	const clearingEnv = {
		...f.env,
		BUCKET: {
			...f.bucket,
			delete: async (key) => {
				if (String(key) === "clear-first.eml") {
					// The real settings route clears the rule while the purge is running.
					const response = await f.setRule(f.sessions.a, "news", null);
					assert.equal(response.status, 200);
					assert.equal(f.db.prepare("SELECT retention_days FROM folders WHERE id = 'news'").get().retention_days, null);
				}
				return f.bucket.delete(key);
			},
		},
	};

	assert.equal(await runTrashRetention(clearingEnv, NOW), 1);
	assert.equal(f.messageRow("clear-01"), undefined, "it was already claimed; the claim is before the first destructive call");
	assert.equal(f.messageRow("clear-02")?.folder_id, "news", "not yet reached, and the rule it relied on is gone");
	assert.ok(await f.bucket.head("clear-second.eml"));
});

test("a delegate's message filed in the shared mailbox's ruled folder follows the mailbox owner's rule", async (t) => {
	const f = await fixture(t);
	f.message("delegated", { userId: "b", mailboxId: "a1" });
	assert.equal((await f.bulk(f.sessions.b, { messageIds: ["delegated"], action: "folder", folderId: "news" })).status, 200);

	assert.equal(await runTrashRetention(f.env, NOW), 1);
	assert.equal(f.messageRow("delegated"), undefined);
	assert.deepEqual(
		f.db.prepare("SELECT actor_user_id, mailbox_id FROM audit_logs WHERE action = 'email.delete' AND metadata LIKE '%\"source\":\"retention\"%'").all(),
		[{ actor_user_id: "a", mailbox_id: "a1" }],
		"the audit row is attributed to the mailbox owner, whose rule this is",
	);
});

test("a freshly imported message with an old Date header is eligible on the next run — documented, not a grace period", async (t) => {
	const f = await fixture(t);
	const raw = (date, id) => new TextEncoder().encode([
		"From: Gate <sender@example.test>",
		"To: a@example.test",
		...(date ? [`Date: ${date}`] : []),
		`Message-ID: <${id}@gate.test>`,
		"Subject: f29 sentinel",
		"MIME-Version: 1.0",
		"Content-Type: text/plain",
		"",
		"body",
		"",
	].join("\r\n")).buffer;

	const before = Math.floor(Date.now() / 1000);
	assert.deepEqual(
		await importMessagesToMailbox(f.env, {
			userId: "a",
			mailboxId: "a1",
			destination: { type: "folder", folderId: "news" },
			messages: [{ filename: "old.eml", raw: raw("Mon, 01 Jan 2001 12:00:00 +0000", "old") }, { filename: "undated.eml", raw: raw(null, "undated") }],
		}),
		{ imported: 2, skipped: 0, errors: [] },
	);
	const rows = f.db.prepare("SELECT id, created_at FROM messages ORDER BY created_at").all();
	assert.equal(rows[0].created_at, 978350400, "the Date header is the message date");
	assert.ok(rows[1].created_at >= before, "an undated message gets the import time");

	assert.equal(await runTrashRetention(f.env, NOW), 1, "old imported mail expires immediately; the import time one does not");
	assert.deepEqual(f.db.prepare("SELECT id FROM messages").all().map((row) => row.id), [rows[1].id]);
});

test("an unreachable database is reported as zero deletions, not a rejection", async () => {
	let logged = "";
	const original = console.error;
	console.error = (...args) => { logged += args.join(" "); };
	try {
		const broken = { prepare() { throw new Error("discovery break"); } };
		assert.equal(await runTrashRetention({ DB: broken, BUCKET: { delete: async () => {} } }, NOW), 0);
	} finally {
		console.error = original;
	}
	assert.match(logged, /could not list owners/);
});

test("a really sent message filed into a ruled folder keeps its Sent provenance", async (t) => {
	const f = await fixture(t);
	const id = await f.send("Completed");
	assert.equal(await sendScheduledMessageNow(f.env, id), true, "the scheduled send completes for real");
	f.run("UPDATE messages SET created_at = ? WHERE id = ?", daysAgo(90), id);
	assert.deepEqual(
		f.db.prepare("SELECT messages.direction AS direction, outbound_jobs.status AS status FROM outbound_jobs join messages on messages.id = outbound_jobs.message_id WHERE message_id = ?").get(id),
		{ direction: "outbound", status: "sent" },
		"a terminal job, so the live-job guard is not what protects it",
	);

	assert.equal((await f.bulk(f.sessions.a, { messageIds: [id], action: "folder", folderId: "news" })).status, 200);
	assert.deepEqual(
		f.db.prepare("SELECT folder_id, status, direction FROM messages WHERE id = ?").get(id),
		{ folder_id: "news", status: "received", direction: "outbound" },
		"filing rewrites the status but not the direction",
	);
	assert.equal(await runTrashRetention(f.env, NOW), 0, "a filed sent copy is not folder-retention material");
	assert.equal(f.messageRow(id)?.id, id);
});

test("imported Sent mail with no outbound job, filed into a ruled folder, survives", async (t) => {
	const f = await fixture(t);
	const raw = new TextEncoder().encode([
		"From: A <a@a.test>",
		"To: someone@example.test",
		"Date: Mon, 01 Jan 2001 12:00:00 +0000",
		"Message-ID: <imported-sent@a.test>",
		"Subject: sent copy",
		"MIME-Version: 1.0",
		"Content-Type: text/plain",
		"",
		"body",
		"",
	].join("\r\n")).buffer;
	assert.deepEqual(
		await importMessagesToMailbox(f.env, { userId: "a", mailboxId: "a1", destination: { type: "system", section: "sent" }, messages: [{ filename: "sent.eml", raw }] }),
		{ imported: 1, skipped: 0, errors: [] },
	);
	const [imported] = f.db.prepare("SELECT id, direction, status, created_at FROM messages").all();
	assert.deepEqual([imported.direction, imported.status], ["outbound", "sent"], "the Sent destination records the provenance");
	assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbound_jobs").get().n, 0, "no job row to protect it");

	f.run("UPDATE messages SET created_at = ? WHERE id = ?", daysAgo(90), imported.id);
	assert.equal((await f.bulk(f.sessions.a, { messageIds: [imported.id], action: "folder", folderId: "news" })).status, 200);
	assert.equal(f.db.prepare("SELECT status FROM messages WHERE id = ?").get(imported.id).status, "received");
	assert.equal(await runTrashRetention(f.env, NOW), 0);
	assert.equal(f.messageRow(imported.id)?.id, imported.id);
});

test("a move committed between the key read and the delete still wins", async (t) => {
	const f = await fixture(t);
	f.message("gap", { folderId: "news", rawR2Key: "gap.eml" });
	await f.bucket.put("gap.eml", "gap");

	const paused = pausingDatabase(f.database, async () => {
		// The real bulk route moves the candidate to an unruled folder after its objects were listed.
		assert.equal((await f.bulk(f.sessions.a, { messageIds: ["gap"], action: "folder", folderId: "plain" })).status, 200);
		assert.equal(f.messageRow("gap").folder_id, "plain");
	});

	assert.equal(await runTrashRetention({ ...f.env, DB: paused }, NOW), 0);
	assert.equal(f.messageRow("gap")?.folder_id, "plain", "the conditional delete matched nothing");
	assert.ok(await f.bucket.head("gap.eml"), "and no object was touched");
});

test("a rule enabled during the Trash phase applies from the next run, like one enabled in the folder phase", async (t) => {
	const f = await fixture(t);
	f.run("UPDATE users SET trash_retention_days = 7 WHERE id = 'a'");
	f.run("INSERT INTO folders (id, user_id, mailbox_id, name, retention_days, created_at) VALUES ('late', 'a', 'a1', 'Late', NULL, ?)", daysAgo(400));
	f.message("late-msg", { folderId: "late" });
	f.message("trash-now", { status: "trash", rawR2Key: "trash-now.eml" });
	f.run("UPDATE messages SET trashed_at = ? WHERE id = 'trash-now'", daysAgo(60));
	await f.bucket.put("trash-now.eml", "x");

	const enabling = {
		...f.env,
		BUCKET: {
			...f.bucket,
			delete: async (key) => {
				if (String(key) === "trash-now.eml") {
					// The real settings route enables the rule while the Trash phase is running.
					assert.equal((await f.setRule(f.sessions.a, "late", 7)).status, 200);
				}
				return f.bucket.delete(key);
			},
		},
	};

	assert.equal(await runTrashRetention(enabling, NOW), 1, "only the Trash candidate goes");
	assert.equal(f.messageRow("late-msg")?.id, "late-msg", "rules are snapshotted at run start");
	assert.equal(await runTrashRetention(f.env, NOW), 1, "the next run applies it");
	assert.equal(f.messageRow("late-msg"), undefined);
});

test("clearing the owner's Trash rule mid-phase spares the candidates not yet claimed", async (t) => {
	const f = await fixture(t);
	f.run("UPDATE users SET trash_retention_days = 7 WHERE id = 'a'");
	for (const id of ["trash-a", "trash-b"]) {
		f.message(id, { status: "trash", rawR2Key: `${id}.eml` });
		f.run("UPDATE messages SET trashed_at = ? WHERE id = ?", daysAgo(60), id);
		await f.bucket.put(`${id}.eml`, "x");
	}

	const clearing = {
		...f.env,
		BUCKET: {
			...f.bucket,
			delete: async (key) => {
				if (String(key) === "trash-a.eml") f.run("UPDATE users SET trash_retention_days = NULL WHERE id = 'a'");
				return f.bucket.delete(key);
			},
		},
	};

	assert.equal(await runTrashRetention(clearing, NOW), 1);
	assert.equal(f.messageRow("trash-a"), undefined, "already claimed");
	assert.equal(f.messageRow("trash-b")?.id, "trash-b", "the rule is read again by the conditional delete");
	assert.ok(await f.bucket.head("trash-b.eml"));
});

test("a missing database binding is reported as zero deletions, not a rejection", async () => {
	let logged = "";
	const original = console.error;
	console.error = (...args) => { logged += args.join(" "); };
	try {
		assert.equal(await runTrashRetention({ BUCKET: { delete: async () => {} } }, NOW), 0);
	} finally {
		console.error = original;
	}
	assert.match(logged, /database binding is unavailable/);
});

test("lengthening a folder rule mid-run spares the mail the new rule protects", async (t) => {
	const f = await fixture(t);
	f.message("lengthened", { folderId: "news", rawR2Key: "lengthened.eml" });
	await f.bucket.put("lengthened.eml", "x");

	const paused = pausingDatabase(f.database, async () => {
		// The real settings route accepts a longer window after the candidate was selected.
		assert.equal((await f.setRule(f.sessions.a, "news", 365)).status, 200);
		assert.equal(f.db.prepare("SELECT retention_days FROM folders WHERE id = 'news'").get().retention_days, 365);
	});
	assert.equal(await runTrashRetention({ ...f.env, DB: paused }, NOW), 0, "the old 7-day window no longer applies");
	assert.equal(f.messageRow("lengthened")?.id, "lengthened");
	assert.ok(await f.bucket.head("lengthened.eml"));
	assert.equal(await runTrashRetention(f.env, NOW), 0, "90 days old mail is inside the new 365-day window");
});

test("clearing and re-enabling a folder rule with another value mid-run also defers", async (t) => {
	const f = await fixture(t);
	f.message("re-enabled", { folderId: "news", rawR2Key: "re-enabled.eml" });
	await f.bucket.put("re-enabled.eml", "x");

	const paused = pausingDatabase(f.database, async () => {
		assert.equal((await f.setRule(f.sessions.a, "news", null)).status, 200);
		assert.equal((await f.setRule(f.sessions.a, "news", 14)).status, 200);
	});
	assert.equal(await runTrashRetention({ ...f.env, DB: paused }, NOW), 0);
	assert.equal(f.messageRow("re-enabled")?.id, "re-enabled");
	assert.equal(await runTrashRetention(f.env, NOW), 1, "the next run uses the 14-day rule");
	assert.equal(f.messageRow("re-enabled"), undefined);
});

test("changing the owner's Trash rule mid-phase spares the candidates not yet claimed", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.setTrashRule(f.sessions.a, 7)).status, 200);
	for (const id of ["trash-a", "trash-b"]) {
		f.message(id, { status: "trash", rawR2Key: `${id}.eml` });
		f.run("UPDATE messages SET trashed_at = ? WHERE id = ?", daysAgo(60), id);
		await f.bucket.put(`${id}.eml`, "x");
	}

	const lengthening = {
		...f.env,
		BUCKET: {
			...f.bucket,
			delete: async (key) => {
				// The real settings route lengthens the Trash window while the phase is running.
				if (String(key) === "trash-a.eml") assert.equal((await f.setTrashRule(f.sessions.a, 90)).status, 200);
				return f.bucket.delete(key);
			},
		},
	};

	assert.equal(await runTrashRetention(lengthening, NOW), 1);
	assert.equal(f.messageRow("trash-a"), undefined, "already claimed");
	assert.equal(f.messageRow("trash-b")?.id, "trash-b", "the claim requires the snapshotted days value");
	assert.ok(await f.bucket.head("trash-b.eml"));
});

test("a folder moved to another mailbox mid-run cannot delete mail left behind", async (t) => {
	const f = await fixture(t);
	f.message("stayed", { folderId: "news", rawR2Key: "stayed.eml" });
	await f.bucket.put("stayed.eml", "x");

	const paused = pausingDatabase(f.database, async () => {
		// FK-valid: the folder now belongs to b's mailbox; the message stays in a's shared mailbox.
		f.run("UPDATE folders SET mailbox_id = 'b1', user_id = 'b' WHERE id = 'news'");
	});
	assert.equal(await runTrashRetention({ ...f.env, DB: paused }, NOW), 0);
	assert.deepEqual(
		f.db.prepare("SELECT mailbox_id, folder_id FROM messages WHERE id = 'stayed'").get(),
		{ mailbox_id: "a1", folder_id: "news" },
		"the claim compares the message's mailbox to the folder's current mailbox",
	);
	assert.ok(await f.bucket.head("stayed.eml"));
});

test("a mailbox that changed owner mid-run defers its ruled mail to the next run", async (t) => {
	const f = await fixture(t);
	f.message("owned-elsewhere", { folderId: "news" });
	f.message("owned-elsewhere-2", { folderId: "news" });

	const paused = pausingDatabase(f.database, async () => {
		// The mailbox now belongs to b, so the audit actor would no longer be the rule's owner.
		f.run("UPDATE mailboxes SET user_id = 'b' WHERE id = 'a1'");
	});
	assert.equal(await runTrashRetention({ ...f.env, DB: paused }, NOW), 0);
	assert.equal(f.db.prepare("SELECT count(*) AS n FROM messages").get().n, 2, "nothing is deleted under a stale owner");
});

test("the raw sweeper reaps retention orphans and keeps referenced objects", async (t) => {
	const f = await fixture(t);
	// Objects a retention claim left behind after its row was deleted (crashed or storage failed).
	await f.bucket.put("imports/msg-orphan.eml", "raw");
	await f.bucket.put("attachments/msg-orphan/att-1/file.txt", "attachment");
	// Still referenced: a live message's raw MIME and an attachment row.
	await f.bucket.put("imports/msg-live.eml", "raw");
	f.message("live", { rawR2Key: "imports/msg-live.eml" });
	await f.bucket.put("attachments/msg-live/att-2/keep.txt", "kept");
	f.run("INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES ('att-2', 'live', 'keep.txt', 'text/plain', 4, 'attachment', 'attachments/msg-live/att-2/keep.txt', ?)", daysAgo(1));

	const tomorrow = new Date(Date.now() + 2 * DAY);
	await sweepOrphanedRawMail(f.env, tomorrow);

	assert.equal(await f.bucket.head("imports/msg-orphan.eml"), null, "the orphaned raw MIME is reaped");
	assert.equal(await f.bucket.head("attachments/msg-orphan/att-1/file.txt"), null, "the orphaned attachment object is reaped");
	assert.ok(await f.bucket.head("imports/msg-live.eml"), "a referenced raw MIME survives");
	assert.ok(await f.bucket.head("attachments/msg-live/att-2/keep.txt"), "a referenced attachment survives");
});
