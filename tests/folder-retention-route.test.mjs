import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-folder-retention-route-"));
after(() => {
	rmSync(outDir, { recursive: true, force: true });
	delete globalThis.folderRouteTest;
});

const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/api/auth": "import {NextResponse} from 'next/server'; export async function requireSessionUser(){const state=globalThis.folderRouteTest; return state.user?{user:state.user,error:null}:{user:null,error:NextResponse.json({error:'Unauthorized'},{status:401})}}",
	"@/lib/mailboxes/access": "export async function getMailboxAccessLevel(){return globalThis.folderRouteTest.access ?? null}",
	"@/db": "export function getDb(){return globalThis.folderRouteTest.db}",
};

await build({
	stdin: {
		contents: "export * as retention from './src/app/api/folders/[id]/retention/route';",
		resolveDir: root,
		sourcefile: "folder-retention-route-entry.ts",
	},
	outfile: join(outDir, "route.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "mocks",
		setup(builder) {
			builder.onResolve({ filter: /^(next\/server|@\/db|@\/lib\/(cloudflare|api\/auth|mailboxes\/access))$/ }, (args) => ({ path: args.path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js", resolveDir: root }));
		},
	}],
	logLevel: "silent",
});

const { retention } = await import(pathToFileURL(join(outDir, "route.mjs")).href);
const context = { params: Promise.resolve({ id: "fld_news" }) };
const request = (method = "GET", body) => new Request("https://mail.test/api/folders/fld_news/retention", {
	method,
	...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
});

const user = { id: "u1" };

/** The two drizzle chains the route uses, over one mutable folder row. */
function fakeDb(row) {
	const state = { record: row, updates: [] };
	return {
		state,
		select: () => ({ from: () => ({ where: () => ({ limit: async () => (state.record ? [state.record] : []) }) }) }),
		update: () => ({ set: (values) => ({ where: async () => { state.updates.push(values); state.record = { ...state.record, ...values }; } }) }),
	};
}

function setup({ row = { id: "fld_news", mailboxId: "mb1", retentionDays: 30 }, access = { mailbox: { id: "mb1", userId: "u1" }, canRead: true, canManage: true }, signedIn = true } = {}) {
	const db = fakeDb(row);
	globalThis.folderRouteTest = { db, access, user: signedIn ? user : null };
	return db;
}

test("reading needs a session and access to the folder's mailbox", async () => {
	setup({ signedIn: false });
	assert.equal((await retention.GET(request(), context)).status, 401);

	setup({ row: null });
	assert.equal((await retention.GET(request(), context)).status, 404);

	setup({ access: { mailbox: { id: "mb1", userId: "u2" }, canRead: false, canManage: false } });
	assert.equal((await retention.GET(request(), context)).status, 404);
});

test("reading returns the stored window, with out-of-range values treated as no rule", async () => {
	setup();
	assert.deepEqual(await (await retention.GET(request(), context)).json(), { folderId: "fld_news", days: 30 });

	setup({ row: { id: "fld_news", mailboxId: "mb1", retentionDays: 9999 } });
	assert.deepEqual(await (await retention.GET(request(), context)).json(), { folderId: "fld_news", days: null });

	setup({ row: { id: "fld_news", mailboxId: "mb1", retentionDays: null } });
	assert.deepEqual(await (await retention.GET(request(), context)).json(), { folderId: "fld_news", days: null });
});

test("changing the window needs the manage right and whole days in 1-365", async () => {
	const denied = setup({ access: { mailbox: { id: "mb1", userId: "u2" }, canRead: true, canManage: false } });
	assert.equal((await retention.PATCH(request("PATCH", { days: 7 }), context)).status, 404);
	assert.deepEqual(denied.state.updates, []);

	const db = setup();
	for (const body of [{ days: 0 }, { days: 400 }, { days: 1.5 }, { days: "7" }, {}, "not json"]) {
		assert.equal((await retention.PATCH(request("PATCH", body), context)).status, 400, JSON.stringify(body));
	}
	assert.deepEqual(db.state.updates, []);

	assert.deepEqual(await (await retention.PATCH(request("PATCH", { days: 14 }), context)).json(), { folderId: "fld_news", days: 14 });
	assert.deepEqual(await (await retention.PATCH(request("PATCH", { days: null }), context)).json(), { folderId: "fld_news", days: null });
	assert.deepEqual(db.state.updates, [{ retentionDays: 14 }, { retentionDays: null }]);
});
