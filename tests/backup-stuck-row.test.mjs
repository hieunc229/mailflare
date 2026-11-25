import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("backup-stuck-row", `
	export { createScheduledBackupIfDue, deleteBackup, failStuckBackups, listBackups, updateBackupSettings } from "./src/lib/backups/service.ts";
	export { runScheduledDatabaseBackup } from "./src/lib/backups/runner.ts";
`);

const NOW = new Date();
const seconds = (date) => Math.floor(date.getTime() / 1000);
const MINUTE = 60_000;

async function setup(t) {
	const fixture = await newDatabase(t, `
		INSERT INTO backups (id, status, trigger, created_at, started_at) VALUES
			('stuck-run', 'running', 'scheduled', ${seconds(new Date(NOW.getTime() - 120 * MINUTE))}, ${seconds(new Date(NOW.getTime() - 120 * MINUTE))}),
			('stuck-queued', 'queued', 'manual', ${seconds(new Date(NOW.getTime() - 90 * MINUTE))}, NULL),
			('fresh-run', 'running', 'manual', ${seconds(new Date(NOW.getTime() - 5 * MINUTE))}, ${seconds(new Date(NOW.getTime() - 5 * MINUTE))});`);
	return fixture;
}

const statuses = (sqlite) => Object.fromEntries(sqlite.prepare("SELECT id, status FROM backups").all().map((row) => [row.id, row.status]));

test("a backup killed mid-run is failed once it is old, and a live one is left alone", async (t) => {
	const { env, sqlite } = await setup(t);
	await app.failStuckBackups(env, NOW);
	assert.deepEqual(statuses(sqlite), { "stuck-run": "failed", "stuck-queued": "failed", "fresh-run": "running" });
	assert.match(sqlite.prepare("SELECT error FROM backups WHERE id = 'stuck-run'").get().error, /did not finish/);
});

test("the admin can delete a stuck backup but not one still in progress", async (t) => {
	const { env, sqlite } = await setup(t);
	assert.equal(await app.deleteBackup(env, "stuck-run"), true);
	await assert.rejects(app.deleteBackup(env, "fresh-run"), /in progress/);
	assert.ok(!(sqlite.prepare("SELECT 1 FROM backups WHERE id = 'stuck-run'").get()));
});
