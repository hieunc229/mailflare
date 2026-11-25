import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-block-domain-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		contacts: join(root, "src/lib/contacts/service.ts"),
		routing: join(root, "src/lib/email/routing.ts"),
		db: join(root, "src/db/index.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { blockSenderDomain } = await load("contacts");
const { resolveInboxRuleDestination } = await load("routing");
const { createDb } = await load("db");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = Math.floor(Date.now() / 1000);
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', ?)").run(now);
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', ?)").run(now);
	const env = { DB: database };
	const block = (address) => blockSenderDomain(env, { userId: "u1", mailboxId: "mb1", domainId: "d1", address });
	const destination = async (from) => (await resolveInboxRuleDestination(createDb(database), { mailboxId: "mb1", toAddress: "kevin@example.com", fromAddress: from })).status;
	const hostDomain = (hostname) => database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES (?, 'u1', ?, 'zone', ?)").run(crypto.randomUUID(), hostname, now);
	const ruleCount = () => database.db.prepare("SELECT count(*) AS n FROM routing_rules").get().n;
	return { block, destination, ruleCount, hostDomain };
}

test("blocking a sender domain trashes mail from the domain and its subdomains only", async (t) => {
	const { block, destination } = await createFixture(t);
	assert.deepEqual(await block('"Promo" <Deals@Spammy.Example>'), { domain: "spammy.example", blocked: true });
	assert.equal(await destination("someone.else@spammy.example"), "trash");
	assert.equal(await destination("Name <x@mail.spammy.example>"), "trash");
	assert.equal(await destination("x@notspammy.example"), "received");
	assert.equal(await destination("x@spammy.example.org"), "received");
	assert.equal(await destination("spammy.example@other.example"), "received");
});

test("blocking the same domain twice keeps one rule", async (t) => {
	const { block, ruleCount } = await createFixture(t);
	await block("a@spammy.example");
	await block("b@spammy.example");
	assert.equal(ruleCount(), 1);
});

const refusal = (code) => (error) => error?.code === code;

test("blocking from a subdomain blocks the registrable domain", async (t) => {
	const { block, destination } = await createFixture(t);
	assert.deepEqual(await block("x@mail.spammy.example"), { domain: "spammy.example", blocked: true });
	assert.equal(await destination("y@other.spammy.example"), "trash");
	assert.equal(await destination("y@spammy.example"), "trash");
	assert.deepEqual(await block("x@shop.deals.co.uk"), { domain: "deals.co.uk", blocked: true });
	assert.equal(await destination("y@www.deals.co.uk"), "trash");
	assert.equal(await destination("y@other.co.uk"), "received");
});

test("internationalised domains are stored in punycode and match both spellings", async (t) => {
	const { block, destination } = await createFixture(t);
	assert.deepEqual(await block("Info@Bücher.Example"), { domain: "xn--bcher-kva.example", blocked: true });
	assert.equal(await destination("a@xn--bcher-kva.example"), "trash");
	assert.equal(await destination("a@shop.bücher.example"), "trash");
	assert.equal(await destination("a@other.example"), "received");
});

test("shared mailbox providers cannot be blocked as a domain", async (t) => {
	const { block, ruleCount } = await createFixture(t);
	for (const address of ["a@gmail.com", "a@GoogleMail.com", "a@hotmail.co.uk", "a@yahoo.fr", "a@mail.yahoo.com", "a@outlook.com", "a@icloud.com", "a@proton.me", "a@gmx.de", "a@mail.ru", "a@yandex.ru"]) {
		await assert.rejects(block(address), refusal("SHARED_PROVIDER"), address);
	}
	assert.equal(ruleCount(), 0);
});

test("a domain the installation hosts, or one that contains a hosted domain, cannot be blocked", async (t) => {
	const { block, destination, hostDomain } = await createFixture(t);
	await assert.rejects(block("me@example.com"), refusal("OWN_DOMAIN"));
	await assert.rejects(block("me@mail.example.com"), refusal("OWN_DOMAIN"));
	hostDomain("mail.hosted.example");
	hostDomain("app.team.co.uk");
	await assert.rejects(block("x@hosted.example"), refusal("OWN_DOMAIN"), "parent of a hosted subdomain");
	await assert.rejects(block("x@other.hosted.example"), refusal("OWN_DOMAIN"), "sibling resolves to the same registrable domain");
	await assert.rejects(block("x@team.co.uk"), refusal("OWN_DOMAIN"));
	await assert.rejects(block("not-an-address"), refusal("INVALID_DOMAIN"));
	await assert.rejects(block("a@co.uk"), refusal("INVALID_DOMAIN"));
	await assert.rejects(block("a@evil.example/path"), refusal("INVALID_DOMAIN"));
	assert.equal(await destination("a@example.com"), "received");
});
