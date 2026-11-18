import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(project, "node_modules", "invite-cache-test-"));
const target = join(temporary, "cache.mjs");
await build({
	entryPoints: [join(project, "src/lib/calendar/invite-cache.ts")], outfile: target,
	bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
	plugins: [{ name: "test-auth", setup(builder) {
		builder.onResolve({ filter: /^@\/lib\/auth\/client$/ }, () => ({ path: "auth", namespace: "mock" }));
		builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
			contents: "export const AUTH_SESSION_CHANGED_EVENT='session-changed';export function authFetch(...args){return globalThis.inviteFetch(...args)}", loader: "js",
		}));
	} }],
});
const cache = await import(pathToFileURL(target).href);
after(() => { rmSync(temporary, { recursive: true, force: true }); delete globalThis.inviteFetch; });

const invite = {
	title: "Senior Fullstack Engineer interview",
	description: "",
	location: "https://example.com/call",
	startsAt: "2026-11-13T15:00:00.000Z",
	endsAt: "2026-11-13T15:45:00.000Z",
	allDay: false,
	organizer: "recruiter@example.com",
	method: "REQUEST",
};
const card = { invite, eventId: "evt_1", response: null, canRespond: true };
const response = (value, ok = true, status = ok ? 200 : 500) => ({ ok, status, json: async () => value });

test("concurrent callers share one request; a cached invitation or cached null needs none", async () => {
	cache.clearInviteCache(); let resolve; let requests = 0;
	globalThis.inviteFetch = (url, init) => {
		requests++;
		assert.equal(url, "/api/messages/one/invite");
		assert.equal(init.cache, "no-store");
		return new Promise(done => { resolve = done; });
	};
	const first = cache.fetchInviteCard("one");
	const second = cache.fetchInviteCard("one");
	assert.equal(requests, 1);
	resolve(response(card));
	assert.deepEqual(await first, card);
	assert.deepEqual(await second, card);
	assert.deepEqual(cache.getCachedInviteCard("one"), card);
	assert.deepEqual(await cache.fetchInviteCard("one"), card);
	assert.equal(requests, 1);

	globalThis.inviteFetch = async () => { requests++; return response({ invite: null }); };
	await cache.fetchInviteCard("two");
	await cache.fetchInviteCard("two");
	assert.equal(requests, 2);
	assert.equal(cache.getCachedInviteCard("two"), null);
});

test("auth invalidation rejects an old response and does not cache it", async () => {
	cache.clearInviteCache(); let resolveOld, resolveNew; let requests = 0;
	globalThis.inviteFetch = () => new Promise(done => { requests++; if (requests === 1) resolveOld = done; else resolveNew = done; });
	const old = cache.fetchInviteCard("one");
	const rejected = assert.rejects(old, /invalidated/);
	cache.clearInviteCache();
	const fresh = cache.fetchInviteCard("one");
	resolveOld(response(card)); await rejected;
	assert.equal(cache.getCachedInviteCard("one"), undefined);
	resolveNew(response({ ...card, response: "accepted" }));
	assert.equal((await fresh).response, "accepted");
	assert.equal(cache.getCachedInviteCard("one").response, "accepted");
});

test("a session change while the response body is read rejects the old invocation", async () => {
	cache.clearInviteCache(); let resolveBody;
	globalThis.inviteFetch = async () => ({ ok: true, status: 200, json: () => new Promise(done => { resolveBody = done; }) });
	const pending = cache.fetchInviteCard("one");
	await new Promise(resolve => setTimeout(resolve, 0));
	cache.clearInviteCache();
	resolveBody(card);
	await assert.rejects(pending, /invalidated/);
	assert.equal(cache.getCachedInviteCard("one"), undefined);
});

test("answering one invitation invalidates other cards that may share its event", () => {
	cache.clearInviteCache();
	cache.cacheInviteCard("request", card);
	cache.cacheInviteCard("cancel", { ...card, eventId: null });
	cache.cacheAnsweredInvite("request", { ...card, eventId: "evt_2", response: "accepted" });
	assert.equal(cache.getCachedInviteCard("cancel"), undefined);
	assert.deepEqual(cache.getCachedInviteCard("request"), { ...card, eventId: "evt_2", response: "accepted" });
});

test("a card opened after an answer starts fresh while an earlier card still finishes", async () => {
	cache.clearInviteCache(); const resolves = []; let requests = 0;
	globalThis.inviteFetch = () => new Promise(done => { requests++; resolves.push(done); });
	const earlier = cache.fetchInviteCard("cancel");
	cache.cacheInviteCard("request", card);
	cache.cacheAnsweredInvite("request", { ...card, eventId: "evt_2", response: "accepted" });
	const fresh = cache.fetchInviteCard("cancel");
	assert.equal(requests, 2);
	resolves[0](response({ ...card, eventId: null }));
	assert.equal((await earlier).eventId, null);
	assert.equal(cache.getCachedInviteCard("cancel"), undefined);
	resolves[1](response({ ...card, eventId: "evt_2" }));
	assert.equal((await fresh).eventId, "evt_2");
	assert.equal(cache.getCachedInviteCard("cancel").eventId, "evt_2");
	assert.equal(cache.getCachedInviteCard("request").eventId, "evt_2");
});

test("server failures retry, while an unreadable invitation is remembered as absent", async () => {
	cache.clearInviteCache(); let requests = 0;
	globalThis.inviteFetch = async () => { requests++; return response({ error: "Unavailable" }, false, 500); };
	await assert.rejects(cache.fetchInviteCard("one"), /Unavailable/);
	await assert.rejects(cache.fetchInviteCard("one"), /Unavailable/);
	assert.equal(requests, 2);
	assert.equal(cache.getCachedInviteCard("one"), undefined);

	globalThis.inviteFetch = async () => { requests++; return response({ invite: null, error: "This invitation could not be read" }, false, 422); };
	assert.equal(await cache.fetchInviteCard("two"), null);
	assert.equal(await cache.fetchInviteCard("two"), null);
	assert.equal(requests, 3);
});

test("cached invitations expire and storage stays bounded", () => {
	cache.clearInviteCache(); const now = Date.now; let time = 1000;
	Date.now = () => time;
	try {
		cache.cacheInviteCard("one", card);
		assert.deepEqual(cache.getCachedInviteCard("one"), card);
		time += 600_001;
		assert.equal(cache.getCachedInviteCard("one"), undefined);
		for (let index = 0; index < 101; index++) cache.cacheInviteCard(String(index), card);
		assert.equal(cache.getCachedInviteCard("0"), undefined);
		assert.deepEqual(cache.getCachedInviteCard("100"), card);
	} finally { Date.now = now; }
});
