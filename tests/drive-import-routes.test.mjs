import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-drive-import-routes-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export * as foldersRoute from "./src/app/api/drive/import/folders/route.ts";
			export * as filesRoute from "./src/app/api/drive/import/files/route.ts";
		`,
		resolveDir: root,
		sourcefile: "drive-import-routes-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true, platform: "node", format: "esm", target: "node24",
	tsconfig: join(root, "tsconfig.json"), packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, createSession, foldersRoute, filesRoute } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	const addUser = sql.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'hash', ?, 'user', 1)");
	for (const row of [["owner", "owner@one.test", "Owner"], ["guest", "guest@one.test", "Guest"], ["stranger", "stranger@one.test", "Stranger"]]) addUser.run(...row);
	const env = { DB: database, MAILFLARE_RUNTIME: "node", CF_TOKEN: "test-only" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const sessions = new Map();
	for (const id of ["owner", "guest", "stranger"]) sessions.set(id, await createSession(env, id));
	const counts = [];
	const prepare = database.prepare.bind(database);
	database.prepare = (text) => {
		const statement = prepare(text);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => { counts.push(values.length); return bind(...values); };
		return statement;
	};
	let clock = 1000;
	const addItem = (id, ownerId, parentId, kind, name, extra = {}) => sql.prepare("INSERT INTO drive_items (id, owner_id, parent_id, kind, name, r2_key, size, content_type, upload_id, upload_part_size, upload_fingerprint, trashed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
		.run(id, ownerId, parentId, kind, name, kind === "file" ? `drive/${ownerId}/${id}` : null, extra.size ?? 0, "application/octet-stream", extra.uploadId ?? null, extra.uploadId ? 64 : null, extra.fingerprint ?? null, extra.trashedAt ?? null, extra.createdAt ?? clock++, clock++);
	const call = (route, actor, body) => route.POST(new Request("https://mail.test/api/drive/import", {
		method: "POST", headers: { Authorization: `Bearer ${sessions.get(actor)}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
	}));
	return {
		sql, counts, addItem,
		folders: async (actor, body) => { const response = await call(foldersRoute, actor, body); return { status: response.status, data: await response.json() }; },
		files: async (actor, body) => { const response = await call(filesRoute, actor, body); return { status: response.status, data: await response.json() }; },
		anonymous: (route) => route.POST(new Request("https://mail.test/api/drive/import", { method: "POST", headers: { Authorization: "Bearer not-a-session" }, body: "{}" })),
	};
}
const rows = (sql, where = "1=1") => sql.prepare(`SELECT * FROM drive_items WHERE ${where}`).all();

test("folders are created from paths and found again on a repeat", async (t) => {
	const { sql, folders } = await fixture(t);
	const body = { parentId: null, paths: [["a", "b"], ["a", "c"], ["d"]] };
	const first = await folders("owner", body);
	assert.equal(first.status, 200);
	assert.deepEqual(Object.keys(first.data.folders).sort(), ["a/b", "a/c", "d"]);
	assert.equal(rows(sql).length, 4);
	const row = (name) => rows(sql, `name='${name}'`)[0];
	assert.equal(row("b").parent_id, row("a").id);
	assert.equal(row("a").parent_id, null);
	assert.equal(row("a").owner_id, "owner");
	assert.equal(row("a").kind, "folder");
	assert.equal(first.data.folders["a/b"], row("b").id);
	const second = await folders("owner", body);
	assert.deepEqual(second.data.folders, first.data.folders);
	assert.equal(rows(sql).length, 4);
});

test("an existing folder is reused, the oldest of duplicates, and a trashed one is not", async (t) => {
	const { sql, folders, addItem } = await fixture(t);
	addItem("new", "owner", null, "folder", "Photos", { createdAt: 5000 });
	addItem("old", "owner", null, "folder", "Photos", { createdAt: 10 });
	addItem("gone", "owner", null, "folder", "Docs", { trashedAt: 9 });
	const result = await folders("owner", { parentId: null, paths: [["Photos", "2020"], ["Docs"]] });
	assert.equal(result.data.folders["Photos/2020"] && rows(sql, `id='${result.data.folders["Photos/2020"]}'`)[0].parent_id, "old");
	assert.notEqual(result.data.folders.Docs, "gone");
});

test("another user's folder needs an edit share, and then the folders belong to its owner", async (t) => {
	const { sql, folders, addItem } = await fixture(t);
	addItem("shared", "owner", null, "folder", "Shared");
	assert.equal((await folders("stranger", { parentId: "shared", paths: [["x"]] })).status, 404);
	assert.equal(rows(sql).length, 1);
	sql.prepare("INSERT INTO drive_shares (id, item_id, user_id, role, created_at) VALUES ('s1','shared','guest','view',1)").run();
	assert.equal((await folders("guest", { parentId: "shared", paths: [["x"]] })).status, 404);
	sql.prepare("UPDATE drive_shares SET role='edit'").run();
	const ok = await folders("guest", { parentId: "shared", paths: [["x"]] });
	assert.equal(ok.status, 200);
	assert.equal(rows(sql, `id='${ok.data.folders.x}'`)[0].owner_id, "owner");
	assert.equal((await folders("owner", { parentId: "missing", paths: [["x"]] })).status, 404);
});

test("a path with an unusable segment is reported and the others still work", async (t) => {
	const { sql, folders } = await fixture(t);
	const result = await folders("owner", { parentId: null, paths: [["ok"], ["  spaced  out "], ["a", ".."], ["x".repeat(300)]] });
	assert.equal(result.status, 200);
	assert.deepEqual(Object.keys(result.data.folders), ["ok"]);
	assert.equal(Object.keys(result.data.errors).length, 3);
	assert.equal(rows(sql).length, 1);
});

test("paths nested past the 24 levels the file route can reach are refused, the others still work", async (t) => {
	const { folders, addItem, sql } = await fixture(t);
	let parent = null;
	for (let level = 0; level < 4; level += 1) { addItem(`f${level}`, "owner", parent, "folder", `f${level}`); parent = `f${level}`; }
	const deep = (length) => Array.from({ length }, (_, i) => `n${i}`);
	const result = await folders("owner", { parentId: parent, paths: [deep(21), ["a"]] });
	assert.deepEqual(Object.keys(result.data.folders), ["a"]);
	assert.deepEqual(result.data.errors, { [deep(21).join("/")]: "Folders are nested too deeply" });
	assert.equal(rows(sql).length, 5);
	assert.equal(Object.keys((await folders("owner", { parentId: parent, paths: [deep(20)] })).data.folders).length, 1);
	const top = await folders("owner", { parentId: null, paths: [Array.from({ length: 30 }, (_, i) => `t${i}`)] });
	assert.equal(Object.keys(top.data.errors).length, 1);
});

test("a parent deeper than the 24-level ancestor walk is not found", async (t) => {
	const { folders, addItem } = await fixture(t);
	let parent = null;
	for (let level = 0; level < 25; level += 1) { addItem(`f${level}`, "owner", parent, "folder", `f${level}`); parent = `f${level}`; }
	assert.equal((await folders("owner", { parentId: parent, paths: [["a"]] })).status, 404);
});

test("request shape and size are checked", async (t) => {
	const { folders, files, anonymous } = await fixture(t);
	assert.equal((await folders("owner", { parentId: null, paths: "x" })).status, 400);
	assert.equal((await folders("owner", { parentId: null, paths: [] })).status, 400);
	assert.equal((await folders("owner", { parentId: null, paths: Array.from({ length: 101 }, (_, i) => [`d${i}`]) })).status, 400);
	assert.equal((await folders("owner", { parentId: null, paths: [Array.from({ length: 65 }, () => "d")] })).status, 400);
	assert.equal((await folders("owner", { parentId: null, paths: [[]] })).status, 400);
	assert.equal((await folders("owner", { parentId: null, paths: [[1]] })).status, 400);
	assert.equal((await files("owner", { files: [] })).status, 400);
	assert.equal((await files("owner", { files: Array.from({ length: 141 }, (_, i) => ({ folderId: null, name: `f${i}`, size: 1, fingerprint: "gt:00000000:1" })) })).status, 400);
	assert.equal((await anonymous(foldersRoute)).status, 401);
	assert.equal((await anonymous(filesRoute)).status, 401);
});

test("folder statements stay under D1's 100 bound parameters", async (t) => {
	const { folders, counts, addItem } = await fixture(t);
	for (let i = 0; i < 60; i += 1) addItem(`e${i}`, "owner", null, "folder", `dir${i}`);
	const paths = Array.from({ length: 21 }, (_, i) => [`dir${i}`, `sub${i}`, `leaf${i}`]);
	const result = await folders("owner", { parentId: null, paths });
	assert.equal(Object.keys(result.data.folders).length, 21);
	assert.ok(Math.max(...counts) <= 100, `max params ${Math.max(...counts)}`);
});

/** 4 top folders, 4 children each, 5 leaves each: 100 folders in 3 levels, as paths (every folder, parents first). */
const wideTree = () => {
	const paths = [];
	for (let a = 0; a < 4; a += 1) for (let b = -1; b < 4; b += 1) for (let c = -1; c < (b < 0 ? 0 : 5); c += 1) {
		if (b < 0 && c < 0) { paths.push([`t${a}`]); continue; }
		if (c < 0) paths.push([`t${a}`, `m${b}`]); else paths.push([`t${a}`, `m${b}`, `l${c}`]);
	}
	return paths;
};

test("folders: a wide tree, half of it existing, costs at most 40 queries a request and creates no duplicates", async (t) => {
	const { sql, folders, counts, addItem } = await fixture(t);
	const all = wideTree();
	assert.equal(all.length, 100);
	const ids = new Map();
	all.forEach((path, i) => {
		const id = `x${i}`;
		ids.set(path.join("/"), id);
		if (i % 2 === 0) addItem(id, "owner", path.length > 1 ? ids.get(path.slice(0, -1).join("/")) : null, "folder", path.at(-1));
	});
	const before = rows(sql).length;
	// The parents of an existing folder must exist: odd ancestors of even folders are created by the first run.
	const sizes = [];
	for (let run = 0; run < 2; run += 1) {
		for (let start = 0; start < all.length; start += 50) {
			counts.length = 0;
			const result = await folders("owner", { parentId: null, paths: all.slice(start, start + 50) });
			assert.equal(result.status, 200);
			sizes.push(counts.length);
			t.diagnostic(`run ${run} request ${start / 50}: ${counts.length} queries`);
			assert.ok(counts.length <= 40, `${counts.length} queries`);
			assert.ok(Math.max(...counts) <= 100, `max params ${Math.max(...counts)}`);
		}
		const names = rows(sql, "kind='folder'").map((row) => `${row.parent_id}/${row.name}`);
		assert.equal(new Set(names).size, names.length, "duplicate folders");
		assert.ok(rows(sql).length >= before);
	}
});

test("folders: the worst request, 64 new folders under a parent 4 levels deep, through a share, costs at most 40 queries", async (t) => {
	const { sql, folders, counts, addItem } = await fixture(t);
	let parent = null;
	for (let level = 0; level < 4; level += 1) { addItem(`p${level}`, "owner", parent, "folder", `p${level}`); parent = `p${level}`; }
	sql.prepare("INSERT INTO drive_shares (id, item_id, user_id, role, created_at) VALUES ('s1','p0','guest','edit',1)").run();
	counts.length = 0;
	const result = await folders("guest", { parentId: parent, paths: [Array.from({ length: 20 }, (_, i) => `d${i}`), ...Array.from({ length: 44 }, (_, i) => [`e${i}`])] });
	assert.equal(result.status, 200);
	t.diagnostic(`${counts.length} queries`);
	assert.ok(counts.length <= 40, `${counts.length} queries`);
});

test("folders: more than 64 distinct folders in one request is refused", async (t) => {
	const { sql, folders } = await fixture(t);
	assert.equal((await folders("owner", { parentId: null, paths: Array.from({ length: 65 }, (_, i) => [`d${i}`]) })).status, 400);
	assert.equal((await folders("owner", { parentId: null, paths: [Array.from({ length: 24 }, (_, i) => `d${i}`), ...Array.from({ length: 40 }, (_, i) => [`y${i}`])] })).status, 200);
	assert.equal((await folders("owner", { parentId: null, paths: [["a", "b", "c"], ...Array.from({ length: 62 }, (_, i) => [`z${i}`])] })).status, 400);
	assert.equal(rows(sql).length, 64);
});

const request = (name, size, fingerprint = `gt:0000000${size % 10}:${size}`, folderId = null) => ({ folderId, name, size, fingerprint });

test("files: skip what is there, upload what is not, rename on a name clash", async (t) => {
	const { files, addItem } = await fixture(t);
	addItem("done", "owner", null, "file", "a.txt", { size: 5 });
	addItem("other", "owner", null, "file", "b.txt", { size: 9 });
	addItem("folder", "owner", null, "folder", "c.txt");
	addItem("trash", "owner", null, "file", "d.txt", { size: 5, trashedAt: 3 });
	const result = await files("owner", { files: [request("a.txt", 5), request("b.txt", 5), request("c.txt", 5), request("d.txt", 5), request("e.txt", 5)] });
	assert.equal(result.status, 200);
	assert.deepEqual(result.data.results, [
		{ action: "skip" }, { action: "upload", name: "b (1).txt" }, { action: "upload", name: "c (1).txt" }, { action: "upload", name: "d.txt" }, { action: "upload", name: "e.txt" },
	]);
});

test("files: a pending upload with the same fingerprint resumes, a different one is stepped over", async (t) => {
	const { files, addItem } = await fixture(t);
	addItem("p1", "owner", null, "file", "a.bin", { size: 5, uploadId: "u1", fingerprint: "gt:00000005:5" });
	addItem("p2", "owner", null, "file", "b.bin", { size: 5, uploadId: "u2", fingerprint: "gt:99999999:5" });
	const result = await files("owner", { files: [request("a.bin", 5, "gt:00000005:5"), request("b.bin", 5, "gt:00000005:5")] });
	assert.deepEqual(result.data.results, [{ action: "upload", name: "a.bin" }, { action: "upload", name: "b (1).bin" }]);
});

test("files: names are planned inside the folder given, and clashes inside one request are resolved", async (t) => {
	const { files, addItem } = await fixture(t);
	addItem("dir", "owner", null, "folder", "dir");
	addItem("inside", "owner", "dir", "file", "a.txt", { size: 5 });
	const result = await files("owner", { files: [request("a.txt", 5, undefined, "dir"), request("a.txt", 5), request("a.txt", 7), request("a.txt", 7), request("a.txt", 8)] });
	assert.deepEqual(result.data.results, [{ action: "skip" }, { action: "upload", name: "a.txt" }, { action: "upload", name: "a (1).txt" }, { action: "skip" }, { action: "upload", name: "a (2).txt" }]);
});

test("files: a folder the caller cannot edit is an error for its files only", async (t) => {
	const { files, addItem, sql } = await fixture(t);
	addItem("theirs", "owner", null, "folder", "theirs");
	addItem("mine", "stranger", null, "folder", "mine");
	const result = await files("stranger", { files: [request("a.txt", 5, undefined, "theirs"), request("a.txt", 5, undefined, "mine"), request("a.txt", 5, undefined, "nope")] });
	assert.equal(result.data.results[0].action, "error");
	assert.equal(result.data.results[1].action, "upload");
	assert.equal(result.data.results[2].action, "error");
	assert.equal(result.data.results[0].error, result.data.results[2].error);
	sql.prepare("INSERT INTO drive_shares (id, item_id, user_id, role, created_at) VALUES ('s1','theirs','guest','edit',1)").run();
	assert.equal((await files("guest", { files: [request("a.txt", 5, undefined, "theirs")] })).data.results[0].action, "upload");
});

test("files: names, sizes and fingerprints are validated per file", async (t) => {
	const { files } = await fixture(t);
	const result = await files("owner", { files: [request("  a  b.txt", 5), request("ok.txt", -1), request("ok.txt", 1.5), request("ok.txt", 5, ""), request("ok.txt", 5, "x".repeat(101)), request("ok.txt", 5)] });
	assert.deepEqual(result.data.results.map((entry) => entry.action), ["error", "error", "error", "error", "error", "upload"]);
});

test("files: lookups stay under D1's 100 bound parameters", async (t) => {
	const { files, counts, addItem } = await fixture(t);
	addItem("dir", "owner", null, "folder", "dir");
	for (let i = 0; i < 50; i += 1) addItem(`x${i}`, "owner", "dir", "file", `n${i}.txt`, { size: 7 });
	const batch = Array.from({ length: 140 }, (_, i) => request(`n${i % 120}.txt`, i % 3 === 0 ? 7 : 8, undefined, "dir"));
	const result = await files("owner", { files: batch });
	assert.equal(result.data.results.length, 140);
	assert.ok(Math.max(...counts) <= 100, `max params ${Math.max(...counts)}`);
});

/** 5 top folders with 5 children each: 25 folders, two levels deep. Every child already holds a file of the names in use. */
function seedTree(addItem, owner) {
	const ids = [];
	for (let p = 0; p < 5; p += 1) {
		addItem(`top${p}`, owner, null, "folder", `top${p}`);
		for (let c = 0; c < 5; c += 1) {
			addItem(`sub${p}${c}`, owner, `top${p}`, "folder", `sub${c}`);
			addItem(`a${p}${c}`, owner, `sub${p}${c}`, "file", "a.txt", { size: 7 });
			addItem(`b${p}${c}`, owner, `sub${p}${c}`, "file", "a (1).txt", { size: 7 });
			ids.push(`sub${p}${c}`);
		}
	}
	return ids;
}
const collidingBatch = (ids) => ids.flatMap((folderId, i) => [request("a.txt", 5, undefined, folderId), request("a.txt", 6, undefined, folderId), request("new.txt", 5, undefined, folderId), request(`own${i}.txt`, 7, undefined, folderId)]);

test("files: a 25-folder, 2-deep batch with clashes costs at most 40 queries and names stay right", async (t) => {
	const { files, counts, addItem } = await fixture(t);
	const ids = seedTree(addItem, "owner");
	counts.length = 0;
	const result = await files("owner", { files: collidingBatch(ids) });
	assert.equal(result.status, 200);
	t.diagnostic(`${counts.length} queries`);
	assert.ok(counts.length <= 40, `${counts.length} queries`);
	assert.ok(Math.max(...counts) <= 100, `max params ${Math.max(...counts)}`);
	const [first, second, third, fourth] = result.data.results;
	assert.deepEqual([first, second, third, fourth], [{ action: "upload", name: "a (2).txt" }, { action: "upload", name: "a (3).txt" }, { action: "upload", name: "new.txt" }, { action: "upload", name: "own0.txt" }]);
});

test("files: the same batch through a share costs at most 40 queries", async (t) => {
	const { files, counts, addItem, sql } = await fixture(t);
	const ids = seedTree(addItem, "owner");
	for (let p = 0; p < 5; p += 1) sql.prepare("INSERT INTO drive_shares (id, item_id, user_id, role, created_at) VALUES (?,?,'guest','edit',1)").run(`s${p}`, `top${p}`);
	counts.length = 0;
	const result = await files("guest", { files: collidingBatch(ids) });
	assert.equal(result.status, 200);
	t.diagnostic(`${counts.length} queries`);
	assert.ok(counts.length <= 40, `${counts.length} queries`);
	assert.equal(result.data.results.filter((entry) => entry.action === "upload").length, 100);
});

test("files: a folder nested deeper than the walk allows is refused, not walked to the end", async (t) => {
	const { files, counts, addItem } = await fixture(t);
	let parent = null;
	for (let level = 0; level < 60; level += 1) { addItem(`d${level}`, "owner", parent, "folder", `d${level}`); parent = `d${level}`; }
	addItem("near", "owner", null, "folder", "near");
	counts.length = 0;
	const result = await files("owner", { files: [request("x.txt", 1, undefined, "d59"), request("x.txt", 1, undefined, "near")] });
	assert.deepEqual(result.data.results.map((entry) => entry.action), ["error", "upload"]);
	t.diagnostic(`${counts.length} queries`);
	assert.ok(counts.length <= 40, `${counts.length} queries`);
});

test("files: clash lookups treat %, _ and ! in names literally and cope with names cut to 255 characters", async (t) => {
	const { files, counts, addItem } = await fixture(t);
	const long = `${"x".repeat(251)}.txt`;
	addItem("w1", "owner", null, "file", "50%_off!.txt", { size: 7 });
	addItem("w2", "owner", null, "file", "50%_off! (1).txt", { size: 7 });
	addItem("w3", "owner", null, "file", "50ab_off!.txt", { size: 7 });
	addItem("l1", "owner", null, "file", long, { size: 7 });
	addItem("l2", "owner", null, "file", `${"x".repeat(247)} (1).txt`, { size: 7 });
	counts.length = 0;
	const result = await files("owner", { files: [request("50%_off!.txt", 5), request("50ab_off!.txt", 5), request(long, 5)] });
	assert.deepEqual(result.data.results, [{ action: "upload", name: "50%_off! (2).txt" }, { action: "upload", name: "50ab_off! (1).txt" }, { action: "upload", name: `${"x".repeat(247)} (2).txt` }]);
	assert.ok(counts.length <= 4, `${counts.length} queries`);
});

test("names with invisible characters or in another Unicode form are not accepted from the client", async (t) => {
	const { files, folders, sql } = await fixture(t);
	const bad = ["a\u200bb", "a\u202eb", "a\u0085b", "a\u2066b", "a\ufeffb", "cafe\u0301"];
	const made = await folders("owner", { parentId: null, paths: [...bad.map((name) => [name]), ["caf\u00e9"]] });
	assert.deepEqual(Object.keys(made.data.folders), ["caf\u00e9"]);
	assert.equal(Object.keys(made.data.errors).length, bad.length);
	assert.equal(rows(sql).length, 1);
	const planned = await files("owner", { files: [...bad.map((name) => request(`${name}.txt`, 5)), request("caf\u00e9.txt", 5)] });
	assert.deepEqual(planned.data.results.map((entry) => entry.action), [...bad.map(() => "error"), "upload"]);
});
