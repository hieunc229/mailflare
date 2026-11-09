import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(project, "node_modules", "masked-alias-test-"));
after(() => rmSync(temporary, { recursive: true, force: true }));

const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.maskedAliasDb}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.maskedAliasUser}",
	"@/lib/mailboxes/access": "export async function getMailboxAccessLevel(){return globalThis.maskedAliasAccess} export async function listAccessibleMailboxes(){return []}",
	"@/lib/mailboxes/settings-access": "export async function getMailboxSettingsAccess(){return {canManage:true}}",
	"@/lib/cloudflare-api": `export async function ensureEmailRoutingRuleToWorker(env,zoneId,address){(globalThis.ensuredRoutes??=[]).push(address)}
		export async function deleteEmailRoutingRuleForAddress(env,zoneId,address){(globalThis.deletedRoutes??=[]).push(address)}`,
};

await build({
	stdin: {
		contents: `
			export * as routing from './src/lib/email/routing';
			export * as addresses from './src/lib/mailboxes/domain-addresses';
			export * as sender from './src/lib/email/sender';
			export * as aliasesRoute from './src/app/api/mailboxes/[id]/aliases/route';
			export * as schema from './src/db/schema';
		`,
		resolveDir: project,
		loader: "ts",
	},
	outfile: join(temporary, "masked.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(project, "src") },
	plugins: [{
		name: "test-mocks",
		setup(builder) {
			builder.onResolve({ filter: /^(next\/server|@\/db|@\/lib\/(cloudflare|auth\/cookies|mailboxes\/access|mailboxes\/settings-access|cloudflare-api))$/ }, (args) => ({ path: args.path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
	logLevel: "silent",
});

const { routing, addresses, sender, aliasesRoute, schema } = await import(pathToFileURL(join(temporary, "masked.mjs")).href);

const quote = (value) => `"${value.replaceAll('"', '""')}"`;
let sqlite;
let db;

function setup() {
	sqlite?.close();
	sqlite = new DatabaseSync(":memory:");
	for (const value of Object.values(schema)) {
		let table;
		try {
			table = getTableConfig(value);
		} catch {
			continue;
		}
		sqlite.exec(`CREATE TABLE ${quote(table.name)} (${table.columns.map((column) => `${quote(column.name)} ${column.getSQLType()}`).join(",")})`);
	}
	db = drizzle(async (sql, params, method) => {
		const query = sqlite.prepare(sql);
		if (method === "run") {
			query.run(...params);
			return { rows: [] };
		}
		query.setReturnArrays(true);
		return { rows: query.all(...params) };
	});
	globalThis.maskedAliasDb = db;
	globalThis.maskedAliasUser = { id: "u-owner", role: "admin" };
	globalThis.maskedAliasAccess = { canSendAs: true, canSendOnBehalf: true };
	globalThis.ensuredRoutes = [];
	globalThis.deletedRoutes = [];

	sqlite.exec(`
		INSERT INTO users(id, name, email, disabled) VALUES ('u-owner', 'Alice Owner', 'alice@example.test', 0);
		INSERT INTO domains(id, user_id, hostname, status, zone_id) VALUES
			('d1', 'u-owner', 'example.test', 'active', 'z1'),
			('d2', 'u-owner', 'masked.test', 'active', 'z2');
		INSERT INTO mailboxes(id, user_id, domain_id, local_part, display_name, use_all_domains, disabled) VALUES
			('m1', 'u-owner', 'd1', 'alice', 'Alice M', 0, 0),
			('m2', 'u-owner', 'd2', 'zombie', 'Zed', 1, 0);
		INSERT INTO mailbox_aliases(id, mailbox_id, domain_id, local_part, label, enabled, masked) VALUES
			('a-shop',   'm1', 'd1', 'shop',    'Shopping', 1, 1),
			('a-nolabel','m1', 'd1', 'nolabel', NULL,       1, 1),
			('a-news',   'm1', 'd1', 'news',    NULL,       1, 0),
			('a-dead',   'm1', 'd1', 'dead',    NULL,       0, 1),
			('a-zombie', 'm1', 'd1', 'zombie',  NULL,       0, 1);
		INSERT INTO routing_rules(id, user_id, domain_id, scope, enabled, pattern, match_field, match_operator, match_value, mailbox_id, action, priority)
			VALUES ('r-catchall', 'u-owner', 'd1', 'domain', 1, '*', 'recipient', 'exact', '*', 'm1', 'store', 0);
	`);
}
setup();
after(() => sqlite?.close());

const context = (id) => ({ params: Promise.resolve({ id }) });
const apiRequest = (method, body) =>
	new Request(`https://mail.test/api/mailboxes/m1/aliases`, {
		method,
		headers: { "Content-Type": "application/json" },
		...(body ? { body: JSON.stringify(body) } : {}),
	});

test("enabled aliases deliver inbound mail to their mailbox", async () => {
	for (const local of ["shop", "nolabel", "news"]) {
		const decision = await routing.resolveInboundAddress(db, `${local}@example.test`);
		assert.equal(decision?.action, "store", local);
		assert.equal(decision?.mailbox?.mailboxId, "m1", local);
	}
});

test("a disabled alias rejects instead of falling through to the catch-all", async () => {
	const decision = await routing.resolveInboundAddress(db, "dead@example.test");
	assert.equal(decision?.action, "reject");
});

test("a disabled alias keeps its address claimed against use-all-domains mailboxes", async () => {
	// m2 is a use-all-domains mailbox whose own local part is "zombie"; without
	// the disabled-alias check it (or the catch-all) would absorb the address.
	const decision = await routing.resolveInboundAddress(db, "zombie@example.test");
	assert.equal(decision?.action, "reject");
});

test("unmatched addresses still reach the catch-all mailbox", async () => {
	const decision = await routing.resolveInboundAddress(db, "stranger@example.test");
	assert.equal(decision?.action, "store");
	assert.equal(decision?.mailbox?.mailboxId, "m1");
});

test("disabled aliases are not sendable addresses", async () => {
	const list = await addresses.getMailboxAliasAddresses(db, "m1");
	assert.deepEqual(new Set(list), new Set(["shop@example.test", "nolabel@example.test", "news@example.test"]));
	const domainAddresses = await addresses.getMailboxDomainAddresses(db, {
		id: "m1",
		domainId: "d1",
		localPart: "alice",
		useAllDomains: false,
	});
	assert.equal(domainAddresses.includes("dead@example.test"), false);
});

test("a masked alias sends under its label, not the account name", async () => {
	const env = {};
	const result = await sender.getAuthorizedSenderAddress(env, {
		userId: "u-owner",
		mailboxId: "m1",
		from: "shop@example.test",
	});
	assert.equal(result.fromAddr, '"Shopping" <shop@example.test>');
});

test("a label-less masked alias sends as the bare address", async () => {
	const result = await sender.getAuthorizedSenderAddress({}, {
		userId: "u-owner",
		mailboxId: "m1",
		from: "nolabel@example.test",
	});
	assert.equal(result.fromAddr, "nolabel@example.test");
});

test("plain aliases and the primary address keep the mailbox display name", async () => {
	const viaAlias = await sender.getAuthorizedSenderAddress({}, {
		userId: "u-owner",
		mailboxId: "m1",
		from: "news@example.test",
	});
	assert.equal(viaAlias.fromAddr, '"Alice M" <news@example.test>');
	const primary = await sender.getAuthorizedSenderAddress({}, {
		userId: "u-owner",
		mailboxId: "m1",
		from: "alice@example.test",
	});
	assert.equal(primary.fromAddr, '"Alice M" <alice@example.test>');
});

test("a disabled alias cannot be used as the sender", async () => {
	await assert.rejects(
		sender.getAuthorizedSenderAddress({}, { userId: "u-owner", mailboxId: "m1", from: "dead@example.test" }),
		/Sender address does not match/,
	);
});

test("POST generate creates a random masked enabled alias and its routing rule", async () => {
	const res = await aliasesRoute.POST(apiRequest("POST", { domainId: "d1", generate: true, label: "Temp" }), context("m1"));
	assert.equal(res.status, 200);
	const { aliases } = await res.json();
	const created = aliases.find((alias) => alias.label === "Temp");
	assert.ok(created, "generated alias in response");
	assert.equal(created.masked, true);
	assert.equal(created.enabled, true);
	assert.match(created.localPart, /^[a-z0-9]{10}$/);
	assert.deepEqual(globalThis.ensuredRoutes, [`${created.localPart}@example.test`]);
});

test("POST supports a manually chosen masked alias", async () => {
	const res = await aliasesRoute.POST(apiRequest("POST", { domainId: "d1", localPart: "burner", masked: true, label: "Burner" }), context("m1"));
	assert.equal(res.status, 200);
	const { aliases } = await res.json();
	const created = aliases.find((alias) => alias.localPart === "burner");
	assert.equal(created.masked, true);
	assert.equal(created.label, "Burner");
});

test("POST rejects duplicate addresses and missing local parts", async () => {
	const duplicate = await aliasesRoute.POST(apiRequest("POST", { domainId: "d1", localPart: "dead" }), context("m1"));
	assert.equal(duplicate.status, 409);
	const empty = await aliasesRoute.POST(apiRequest("POST", { domainId: "d1" }), context("m1"));
	assert.equal(empty.status, 400);
});

test("POST rejects normalized duplicates that only differ by dots or +tags", async () => {
	// Routing resolves a.lice+x@example.test to the alice mailbox, so an alias
	// claiming the same normalized address must be refused too.
	const dotted = await aliasesRoute.POST(apiRequest("POST", { domainId: "d1", localPart: "a.lice" }), context("m1"));
	assert.equal(dotted.status, 409);
	const tagged = await aliasesRoute.POST(apiRequest("POST", { domainId: "d1", localPart: "sh.op+extra" }), context("m1"));
	assert.equal(tagged.status, 409);
});

test("routing cleanup still sees disabled aliases while sender lookups do not", async () => {
	// ensure/remove must cover every address whose Cloudflare rule exists —
	// including disabled aliases — or stale rules would leak mail to catch-alls.
	const all = await addresses.getMailboxAliasAddresses(db, "m1", true);
	assert.ok(all.includes("dead@example.test") && all.includes("zombie@example.test"));
	const sendable = await addresses.getMailboxAliasAddresses(db, "m1");
	assert.ok(!sendable.includes("dead@example.test") && !sendable.includes("zombie@example.test"));

	const domainAll = await addresses.getMailboxDomainAddresses(db, {
		id: "m1",
		domainId: "d1",
		localPart: "alice",
		useAllDomains: false,
	}, true);
	assert.ok(domainAll.includes("dead@example.test"));
});

test("the delivery-time check finds an alias disabled since queueing", async () => {
	// deliverEmail revalidates with includeDisabled=true: a queued job whose
	// sender alias was turned off must surface enabled=false.
	const stale = await addresses.getMailboxAliasForAddress(db, "m1", "dead@example.test", true);
	assert.equal(stale?.enabled, false);
	const active = await addresses.getMailboxAliasForAddress(db, "m1", "shop@example.test", true);
	assert.equal(active?.enabled, true);
	// The default lookup stays enabled-only so disabled aliases never send.
	const hidden = await addresses.getMailboxAliasForAddress(db, "m1", "dead@example.test");
	assert.equal(hidden, null);
});

test("PATCH toggles enabled, which removes the address from send and delivery", async () => {
	const res = await aliasesRoute.PATCH(apiRequest("PATCH", { aliasId: "a-news", enabled: false }), context("m1"));
	assert.equal(res.status, 200);
	const { aliases } = await res.json();
	assert.equal(aliases.find((alias) => alias.id === "a-news")?.enabled, false);

	const list = await addresses.getMailboxAliasAddresses(db, "m1");
	assert.equal(list.includes("news@example.test"), false);
	const decision = await routing.resolveInboundAddress(db, "news@example.test");
	assert.equal(decision?.action, "reject");

	const back = await aliasesRoute.PATCH(apiRequest("PATCH", { aliasId: "a-news", enabled: true }), context("m1"));
	assert.equal(back.status, 200);
	assert.equal((await routing.resolveInboundAddress(db, "news@example.test"))?.action, "store");
});

test("PATCH updates the label and rejects bad input", async () => {
	const res = await aliasesRoute.PATCH(apiRequest("PATCH", { aliasId: "a-shop", label: "Shops" }), context("m1"));
	assert.equal(res.status, 200);
	const { aliases } = await res.json();
	assert.equal(aliases.find((alias) => alias.id === "a-shop")?.label, "Shops");

	const missing = await aliasesRoute.PATCH(apiRequest("PATCH", { aliasId: "a-missing", enabled: false }), context("m1"));
	assert.equal(missing.status, 404);
	const noop = await aliasesRoute.PATCH(apiRequest("PATCH", { aliasId: "a-shop" }), context("m1"));
	assert.equal(noop.status, 400);
});
