import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// The purge reads a mailbox's raw mail keys and attachments in id-ordered pages instead of loading every row.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-account-purge-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const table = (name, columns) => `export const ${name}={__t:${JSON.stringify(name)},${columns.map((c) => `${c}:${JSON.stringify(`${name}.${c}`)}`).join(",")}};`;
const mocks = {
	"drizzle-orm": "export const eq=(c,v)=>({eq:[c,v]});export const and=(...a)=>({and:a});export const gt=(c,v)=>({gt:v});export const lte=(c,v)=>({lte:v});export const isNotNull=(c)=>({isNotNull:c});export const isNull=(c)=>({isNull:c});export const inArray=(c,v)=>({inArray:[c,v]});export const sql=(strings,...v)=>({sql:v});",
	"@/db/schema": ["calendarEvents", "driveItems", "mailboxes", "messageAttachments", "messages", "sessions", "users"].map((name) => table(name, ["id", "rawR2Key", "r2Key", "mailboxId", "messageId", "ownerId", "userId", "parentId", "deletedAt", "avatarKey"])).join(""),
	"@/db": `
		const cursorOf = (cond) => { let found = ""; const walk = (n) => { if (!n || typeof n !== "object") return; if ("gt" in n) found = n.gt; for (const v of Object.values(n)) walk(v); }; walk(cond); return found; };
		const rowsFor = (name, cursor, limit) => {
			if (name === "users") return [{ id: "u1", avatarKey: null, deletedAt: 1 }];
			if (name === "driveItems") return globalThis.__driveItems;
			if (name === "mailboxes") return [{ id: "mb", userId: "u1" }];
			const source = name === "messages" ? globalThis.__messages : name === "messageAttachments" ? globalThis.__attachments : [];
			return source.filter((row) => row.id > cursor).slice(0, limit ?? source.length);
		};
		export function getDb() {
			return {
				select() {
					const state = {};
					const chain = {
						from(t) { state.name = t.__t; return chain; },
						innerJoin() { return chain; },
						where(cond) { state.cond = cond; return chain; },
						orderBy() { return chain; },
						limit(n) { state.limit = n; return chain; },
						then(resolve, reject) {
							globalThis.__selects.push(state.name);
							return Promise.resolve(rowsFor(state.name, cursorOf(state.cond), state.limit)).then(resolve, reject);
						},
					};
					return chain;
				},
				insert() { return { values: async () => {} }; },
				update(t) { return { set(values) { globalThis.__updates.push({ table: t.__t, values }); return { where: async () => {} }; } }; },
				delete() { return { where() { globalThis.__userDeleted = true; return Promise.resolve(); } }; },
			};
		}`,
	"@/db/sql": "export const concatText=(...parts)=>({concat:parts})",
	"@/lib/auth/admin": "export const canManageUsers=()=>true;export const isPrimaryAdmin=()=>true;",
	"@/lib/drive/access": "export const deleteDriveItems=async()=>{}",
	"@/lib/drive/utils": "export const driveObjectKey=(o,i)=>`drive/${o}/${i}`",
	"@/lib/ids": "export const newId=()=>'id'",
	"@/lib/licenses/seats": "export const getAccountSeatError=async()=>null",
	"@/lib/mailboxes/domain-addresses": "export const removeMailboxDomainRouting=async()=>{}",
	"@/app/api/profile/avatar/utils": "export const avatarKeyFor=(id)=>`avatars/${id}`",
	"./deletion-utils": "export const getAccountPurgeCutoff=()=>new Date(0)",
	"@/lib/drive/shared-objects": "export async function deleteUnreferencedObjects(env,db,keys,exclude){globalThis.__unreferenced.push({keys:[...keys],excluded:[...(exclude.attachmentIds??[])]})}",
};
await build({
	stdin: { contents: "export { runAccountRetention, transferAccountData } from './src/lib/accounts/deletion';", resolveDir: root, loader: "ts" },
	outfile: join(outDir, "deletion.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "mock-deps",
		setup(builder) {
			const names = Object.keys(mocks).map((name) => name.replace(/[/.-]/g, "\\$&")).join("|");
			builder.onResolve({ filter: new RegExp(`^(${names})$`) }, (args) => ({ path: args.path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
	logLevel: "silent",
});
const { runAccountRetention, transferAccountData } = await import(pathToFileURL(join(outDir, "deletion.mjs")).href);

const pad = (n) => String(n).padStart(5, "0");
beforeEach(() => {
	globalThis.__selects = [];
	globalThis.__unreferenced = [];
	globalThis.__userDeleted = false;
	globalThis.__updates = [];
	globalThis.__driveItems = [];
	globalThis.__messages = Array.from({ length: 2500 }, (_, i) => ({ id: `m${pad(i)}`, key: `raw/${pad(i)}` }));
	globalThis.__attachments = Array.from({ length: 1500 }, (_, i) => ({ id: `a${pad(i)}`, key: `att/${pad(i)}` }));
});

test("a purge removes every raw key exactly once, in pages of at most 1000", async () => {
	const deletes = [];
	const env = { BUCKET: { delete: async (keys) => { deletes.push(Array.isArray(keys) ? keys : [keys]); } } };
	assert.equal(await runAccountRetention(env), 1);
	const raw = deletes.filter((group) => group[0].startsWith("raw/"));
	assert.deepEqual(raw.map((group) => group.length), [1000, 1000, 500]);
	assert.deepEqual(raw.flat(), globalThis.__messages.map((row) => row.key));
	assert.equal(globalThis.__selects.filter((name) => name === "messages").length, 4);
	assert.ok(globalThis.__userDeleted);
});

test("attachments are read in pages, each page excluding every attachment seen so far", async () => {
	const env = { BUCKET: { delete: async () => {} } };
	await runAccountRetention(env);
	const pages = globalThis.__unreferenced;
	assert.deepEqual(pages.map((page) => page.keys.length), [1000, 500]);
	assert.deepEqual(pages.flatMap((page) => page.keys), globalThis.__attachments.map((row) => row.key));
	assert.equal(pages[1].excluded.length, 1500);
	assert.equal(globalThis.__selects.filter((name) => name === "messageAttachments").length, 3);
});

test("transferAccountData pins every unpinned Drive file with one update", async () => {
	globalThis.__driveItems = [
		{ id: "f1", kind: "file", parentId: null, r2Key: null },
		{ id: "f2", kind: "file", parentId: "d1", r2Key: null },
		{ id: "f3", kind: "file", parentId: "d1", r2Key: "att/shared" },
		{ id: "d1", kind: "folder", parentId: null, r2Key: null },
	];
	await transferAccountData({}, "from", "Old", "to");
	const pins = globalThis.__updates.filter((update) => update.table === "driveItems" && "r2Key" in update.values);
	assert.equal(pins.length, 1);
	assert.equal(pins[0].values.r2Key.concat[0], "drive/");
});
