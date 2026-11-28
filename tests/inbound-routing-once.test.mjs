import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-routing-once-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { getAccountForwardingDestination } from "./src/lib/email/account-forwarding.ts";
			export { recordRuleMatch } from "./src/lib/email/routing.ts";
		`,
		resolveDir: root,
		sourcefile: "routing-once-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
	plugins: [{
		name: "mocks",
		setup(builder) {
			const mocks = {
				"@/db": `export function getDb() { return globalThis.__onceDb; }`,
				"@/lib/licenses/service": `export async function getLicenseEntitlements() { return { canForwardEmail: true }; }`,
				// Only account-forwarding's import is mocked; routing.ts is bundled for recordRuleMatch below.
			};
			builder.onResolve({ filter: /^@\/(db|lib\/licenses\/service)$/ }, ({ path }) => ({ path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ loader: "js", contents: mocks[path] }));
		},
	}],
});
const { getAccountForwardingDestination, recordRuleMatch } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

// A drizzle-shaped fake that counts statements: select(...).from().where().limit() resolves to `rows`.
function fakeDb({ rows = [] } = {}) {
	const log = [];
	const chain = (kind, result) => {
		const node = { then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
		for (const method of ["from", "where", "limit", "orderBy", "innerJoin", "set"]) node[method] = (...args) => { log.push([kind, method, args]); return node; };
		return node;
	};
	return { log, select: () => { log.push(["select"]); return chain("select", rows); }, update: () => { log.push(["update"]); return chain("update", []); } };
}

test("account forwarding uses the mailbox the caller resolved: one read of the owner's address", async () => {
	const db = fakeDb({ rows: [{ forwardingEmail: "x@example.org" }] });
	globalThis.__onceDb = db;
	assert.equal(await getAccountForwardingDestination({}, "me@one.test", { userId: "u1" }), "x@example.org");
	assert.equal(db.log.filter((entry) => entry.length === 1 && entry[0] === "select").length, 1);
});

test("an account without a forwarding address does not forward", async () => {
	globalThis.__onceDb = fakeDb({ rows: [{ forwardingEmail: null }] });
	assert.equal(await getAccountForwardingDestination({}, "me@one.test", { userId: "u1" }), null);
});

test("mail to the forwarding address itself is not forwarded back", async () => {
	globalThis.__onceDb = fakeDb({ rows: [{ forwardingEmail: "Me <me@one.test>" }] });
	assert.equal(await getAccountForwardingDestination({}, "me@one.test", { userId: "u1" }), null);
});

test("recordRuleMatch is one UPDATE with an in-database increment and no SELECT", async () => {
	const db = fakeDb();
	await recordRuleMatch(db, "r1");
	assert.deepEqual(db.log.filter((entry) => entry.length === 1).map(([kind]) => kind), ["update"]);
	const set = db.log.find(([, method]) => method === "set")[2][0];
	assert.notEqual(typeof set.matchCount, "number");
	assert.ok(set.matchCount, "matchCount is a SQL expression");
	const text = set.matchCount.queryChunks.map((chunk) => (typeof chunk === "object" && "value" in chunk ? chunk.value.join("") : "")).join("");
	assert.match(text, /\+ 1/);
});

test("recordRuleMatch on a missing rule does not throw", async () => {
	await assert.doesNotReject(recordRuleMatch(fakeDb(), "missing"));
});
