import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// A domain added with "Skip DNS setup" on an install without Cloudflare
// credentials is stored as pending, and inbound routing only resolves active
// domains. Confirming the records from the banner must make it receive (#335).

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-dns-skipped-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { domains } from "./src/db/schema/index.ts";
			export { addDomainForUser, dnsSkippedUpdate } from "./src/lib/domains/service.ts";
			export { resolveInboundAddress } from "./src/lib/email/routing.ts";
		`,
		resolveDir: root,
		sourcefile: "dns-skipped-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, getDb, domains, addDomainForUser, dnsSkippedUpdate, resolveInboundAddress } =
	await import(pathToFileURL(join(directory, "entry.mjs")).href);
const { eq } = await import("drizzle-orm");

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	t.mock.method(globalThis, "fetch", async (url) => { throw new Error(`unexpected fetch ${url}`); });
	database.db.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('usr_1', 'admin@example.com', 'x', 'Admin', 'admin', 0)").run();
	return { env, database };
}

async function confirmDns(env, domain) {
	const update = dnsSkippedUpdate(domain, false);
	await getDb(env).update(domains).set(update).where(eq(domains.id, domain.id));
	return update;
}

test("confirming DNS on a skipped manual domain activates it and mail for its mailboxes routes", async (t) => {
	const { env, database } = await fixture(t);
	const { domain } = await addDomainForUser(env, "usr_1", "example.com", { skipDns: true });
	assert.equal(domain.status, "pending");
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mbx_1', 'usr_1', ?, 'admin', 0)").run(domain.id);
	assert.equal(await resolveInboundAddress(getDb(env), "admin@example.com"), null);

	const update = await confirmDns(env, domain);
	assert.deepEqual(update, { dnsSkipped: false, status: "active", routingEnabled: true, routingStatus: "manual" });
	const decision = await resolveInboundAddress(getDb(env), "admin@example.com");
	assert.equal(decision?.action, "store");
	assert.equal(decision.mailbox?.mailboxId, "mbx_1");
});

test("only the flag changes for a domain on a real zone or one that is already active", () => {
	assert.deepEqual(dnsSkippedUpdate({ zoneId: "zone_123", status: "pending" }, false), { dnsSkipped: false });
	assert.deepEqual(dnsSkippedUpdate({ zoneId: "manual", status: "active" }, false), { dnsSkipped: false });
	assert.deepEqual(dnsSkippedUpdate({ zoneId: "manual", status: "pending" }, true), { dnsSkipped: true });
});
