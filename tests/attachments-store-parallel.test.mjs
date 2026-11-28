import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { getTableName } from "drizzle-orm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-attachments-parallel-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/email/attachments.ts")],
	outfile: join(directory, "attachments.mjs"),
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
				"@/db": `export function getDb() { return globalThis.__attDb; }`,
				"@/lib/mailboxes/access": `export async function getMailboxAccessLevel() { return { canRead: true }; }`,
			};
			builder.onResolve({ filter: /^@\/(db|lib\/mailboxes\/access)$/ }, ({ path }) => ({ path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ loader: "js", contents: mocks[path] }));
		},
	}],
});
const app = await import(pathToFileURL(join(directory, "attachments.mjs")).href);

// Drizzle-shaped fake: records inserts and the column set of each select.
function fakeDb({ selectRows = [] } = {}) {
	const inserts = [];
	const selects = [];
	const chain = (rows) => {
		const node = { then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject) };
		for (const method of ["from", "where", "limit", "orderBy"]) node[method] = () => node;
		return node;
	};
	return {
		inserts,
		selects,
		insert: (table) => ({ values: async (values) => { inserts.push({ table: getTableName(table), rows: [].concat(values) }); } }),
		select: (columns) => { selects.push(columns ? Object.keys(columns) : null); return chain(selectRows.shift?.() ?? []); },
	};
}

function fakeBucket({ failOn = [] } = {}) {
	const objects = new Map();
	let puts = 0;
	return {
		objects,
		async put(key, value) { puts += 1; if (failOn.includes(puts)) throw new Error("put failed"); objects.set(key, value); },
		async delete(keys) { for (const key of [].concat(keys)) objects.delete(key); },
		async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; },
	};
}

const files = (count) => Array.from({ length: count }, (_, index) => ({ filename: `f${index}.txt`, type: "text/plain", content: new TextEncoder().encode("hi").buffer }));

test("one failed upload removes the objects already written and inserts no rows", async () => {
	const db = fakeDb();
	const bucket = fakeBucket({ failOn: [2] });
	globalThis.__attDb = db;
	await assert.rejects(app.storeMessageAttachments({ BUCKET: bucket }, "m1", files(3), { validate: false }), /put failed/);
	assert.equal(bucket.objects.size, 0);
	assert.deepEqual(db.inserts, []);
});

test("rows are inserted in batches of 11 (9 bound parameters per row stay under 100)", async () => {
	const db = fakeDb();
	const bucket = fakeBucket();
	globalThis.__attDb = db;
	const stored = await app.storeMessageAttachments({ BUCKET: bucket }, "m1", files(13), { validate: false });
	assert.equal(stored.length, 13);
	assert.deepEqual(db.inserts.map((insert) => insert.rows.length), [11, 2]);
	assert.deepEqual(stored.map((attachment) => attachment.filename), files(13).map((file) => file.filename));
	assert.equal(bucket.objects.size, 13);
});

test("the attachment ACL check reads only the message columns it uses", async () => {
	const db = fakeDb({ selectRows: [[{ id: "m1", mailboxId: "box", userId: "u1", privateDraft: false }], []] });
	globalThis.__attDb = db;
	await app.getAttachmentForUser({ BUCKET: fakeBucket() }, { id: "u1", role: "user" }, "m1", "a1");
	assert.ok(db.selects[0], "the message select names its columns");
	assert.ok(!db.selects[0].includes("textBody") && !db.selects[0].includes("htmlBody"));
});
