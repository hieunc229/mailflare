import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-undo-actions-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export {
				getMessageActionPatch, getChangedStateFields, recordHasChanges, planUndoRecord, snapshotMessageState,
			} from "./src/lib/messages/actions/definitions.ts";
			export {
				MessageActionExecutor, MessageActionRequestError, getChangedRecords, hasMembershipChange,
			} from "./src/lib/messages/actions/executor.ts";
			export { signUndoToken, verifyUndoToken } from "./src/lib/messages/actions/token.ts";
			export { defaultMessageActionHooks } from "./src/lib/messages/actions/client.ts";
			export {
				fetchMessageList, peekMessageList, clearMessageListCache, invalidateMessageListRequests,
			} from "./src/hooks/utils.ts";
			export { primeMessageDetail, getCachedMessageDetail } from "./src/lib/messages/detail-cache.ts";
			export {
				captureMessageFields, rememberMessageFields, clearKnownMessageFieldsForTests,
			} from "./src/lib/messages/field-store.ts";
		`,
		resolveDir: root,
		sourcefile: "message-action-undo-entry.ts",
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
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

await build({
	entryPoints: [join(root, "src/hooks/utils.ts")],
	outfile: join(directory, "cache.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const cache = await import(pathToFileURL(join(directory, "cache.mjs")).href);

const state = (overrides = {}) => ({
	status: "received",
	read: false,
	starred: false,
	folderId: null,
	snoozedUntil: null,
	...overrides,
});

const record = (previous, applied, overrides = {}) => ({
	id: "m1",
	mailboxId: "mb1",
	previous,
	applied,
	...overrides,
});

const target = (overrides = {}) => ({
	id: "m1",
	mailboxId: "mb1",
	direction: "inbound",
	status: "received",
	read: false,
	starred: false,
	folderId: null,
	snoozedUntil: null,
	...overrides,
});

test("actions write only their reversible fields", () => {
	assert.deepEqual(m.getMessageActionPatch("archive", {}, target()).patch, { status: "archived", folderId: null });
	assert.deepEqual(m.getMessageActionPatch("trash", {}, target()).patch, { status: "trash", folderId: null });
	assert.deepEqual(m.getMessageActionPatch("inbox", {}, target()).patch, { status: "received", folderId: null, snoozedUntil: null });
	assert.deepEqual(m.getMessageActionPatch("folder", { folderId: "f1" }, target()).patch, { status: "received", folderId: "f1" });
	assert.deepEqual(m.getMessageActionPatch("read", {}, target()).patch, { read: true });
	assert.deepEqual(m.getMessageActionPatch("star", {}, target()).patch, { starred: true });
	assert.equal(m.getMessageActionPatch("spam", {}, target({ direction: "outbound" })).reason, "not_applicable");
	assert.equal(m.getMessageActionPatch("snooze", { snoozedUntil: "2000-01-01T00:00:00.000Z" }, target()).reason, "invalid_target");
	assert.equal(m.getMessageActionPatch("folder", {}, target()).reason, "invalid_target");
});

test("only fields the action changed are marked for undo", () => {
	const previous = state({ read: true });
	const applied = state({ read: true, status: "archived", folderId: "f1" });
	assert.deepEqual(m.getChangedStateFields(previous, applied), ["status", "folderId"]);
	assert.equal(m.recordHasChanges({ previous, applied }), true);
	assert.equal(m.recordHasChanges({ previous, applied: previous }), false);
});

test("undo restores read with read access and status with manage access", () => {
	const previous = state();
	const applied = state({ read: true });
	const readPlan = m.planUndoRecord(record(previous, applied), target({ read: true }), { canRead: true, canManage: false }, null);
	assert.deepEqual(readPlan.patch, { read: false });
	assert.deepEqual(readPlan.fields, ["read"]);

	const archivePrevious = state({ status: "received", folderId: "f1" });
	const archiveApplied = state({ status: "archived", folderId: null });
	const archiveCurrent = target({ status: "archived", folderId: null });
	const forbidden = m.planUndoRecord(record(archivePrevious, archiveApplied), archiveCurrent, { canRead: true, canManage: false }, "mb1");
	assert.equal(forbidden.reason, "forbidden");
	const allowed = m.planUndoRecord(record(archivePrevious, archiveApplied), archiveCurrent, { canRead: true, canManage: true }, "mb1");
	assert.deepEqual(allowed.patch, { status: "received", folderId: "f1" });
});

test("undo rejects a foreign folder, a foreign mailbox and malformed snapshots", () => {
	const previous = state({ status: "archived", folderId: "foreign" });
	const applied = state();
	assert.equal(m.planUndoRecord(record(previous, applied), target(), { canRead: true, canManage: true }, "other-mailbox").reason, "invalid_target");
	assert.equal(m.planUndoRecord(record(previous, applied, { mailboxId: "other" }), target(), { canRead: true, canManage: true }, "mb1").reason, "forbidden");
	assert.equal(m.planUndoRecord(record(state({ status: "hacked" }), applied), target(), { canRead: true, canManage: true }, null).reason, "invalid_target");
});

test("a read undo ignores a folder that was removed after the read action", () => {
	const recordWithFolder = record(
		state({ status: "received", folderId: "deleted-folder" }),
		state({ status: "received", folderId: "deleted-folder", read: true }),
	);
	const plan = m.planUndoRecord(recordWithFolder, target({ read: true, folderId: "deleted-folder" }), { canRead: true, canManage: true }, undefined);
	assert.deepEqual(plan.patch, { read: false });
});

test("undo is skipped when a later action changed the same field", () => {
	const previous = state();
	const applied = state({ status: "archived" });
	assert.equal(m.planUndoRecord(record(previous, applied), target({ status: "trash" }), { canRead: true, canManage: true }, null).reason, "stale");
	// A different field changed later does not block restoring the action's field.
	const starredLater = target({ status: "archived", starred: true });
	assert.deepEqual(m.planUndoRecord(record(previous, applied), starredLater, { canRead: true, canManage: true }, null).patch, { status: "received" });
});

test("a mixed undo restores eligible messages and reports the rest", () => {
	const previous = state();
	const applied = state({ read: true });
	const records = [
		record(previous, applied, { id: "m1" }),
		record(previous, applied, { id: "m2" }),
		record(previous, applied, { id: "m3" }),
	];
	const current = new Map([
		["m1", target({ id: "m1", read: true })],
		["m2", target({ id: "m2", read: false })],
	]);
	const restored = [];
	const skipped = [];
	for (const item of records) {
		const now = current.get(item.id);
		if (!now) {
			skipped.push(item.id);
			continue;
		}
		const plan = m.planUndoRecord(item, now, { canRead: true, canManage: true }, null);
		if (plan.patch) restored.push(item.id);
		else skipped.push(plan.reason);
	}
	assert.deepEqual(restored, ["m1"]);
	assert.deepEqual(skipped, ["stale", "m3"]);
});

test("signed undo tokens carry the exact server records and reject tampering or expiry", async () => {
	const payload = {
		v: 2,
		issuedAt: Date.now(),
		action: "archive",
		userId: "user-1",
		nonce: "nonce-1",
		records: [record(state(), state({ status: "archived" }))],
	};
	const token = await m.signUndoToken("test-secret", payload);
	const verified = await m.verifyUndoToken("test-secret", token);
	assert.deepEqual(verified.records, payload.records);
	assert.equal(await m.verifyUndoToken("other-secret", token), null);
	assert.equal(await m.verifyUndoToken("test-secret", `${token.slice(0, -2)}xx`), null);
	assert.equal(await m.verifyUndoToken("test-secret", token, payload.issuedAt + 11 * 60_000), null);
});

function applyResponse(overrides = {}) {
	return {
		ok: true,
		action: "read",
		applied: [record(state(), state({ read: true }))],
		skipped: [],
		undoToken: "token",
		...overrides,
	};
}

async function seedListCache(params, messages) {
	m.clearMessageListCache();
	m.clearKnownMessageFieldsForTests();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ messages, total: messages.length, limit: 25, offset: 0 });
	try {
		await m.fetchMessageList(params, true);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

function captureEvents(fn) {
	const events = [];
	const previousWindow = globalThis.window;
	globalThis.window = { dispatchEvent: (event) => { events.push(event.detail); } };
	try {
		fn();
	} finally {
		globalThis.window = previousWindow;
	}
	return events;
}

test("the executor reports a successful apply after the server confirms it", async () => {
	const calls = [];
	const applied = [];
	const executor = new m.MessageActionExecutor(
		async (body) => { calls.push(body); return applyResponse(); },
		{ onApplied: (response, options) => applied.push({ response, options }) },
	);
	const result = await executor.run({ action: "read", messageIds: ["m1"] });
	assert.equal(result.applied.length, 1);
	assert.equal(calls[0].op, "apply");
	assert.deepEqual(applied[0].options, { notify: true });
	assert.equal(m.getChangedRecords(result.applied).length, 1);
});

test("a future optimistic apply can patch before the request and roll back on failure", async () => {
	const order = [];
	const executor = new m.MessageActionExecutor(
		async () => {
			order.push("request");
			throw new Error("network down");
		},
		{
			onApplyOptimistic: () => order.push("optimistic"),
			onApplyFailed: () => order.push("rollback"),
		},
	);
	await assert.rejects(executor.run({ action: "read", messageIds: ["m1"] }), /network down/);
	assert.deepEqual(order, ["optimistic", "request", "rollback"]);
});

test("an apply failure does not run success hooks", async () => {
	let applied = 0;
	const executor = new m.MessageActionExecutor(
		async () => { throw new Error("network down"); },
		{ onApplied: () => { applied += 1; } },
	);
	await assert.rejects(executor.run({ action: "archive", messageIds: ["m1"] }), /network down/);
	assert.equal(applied, 0);
});

test("undo runs an optimistic hook before the request and rolls back on failure", async () => {
	const order = [];
	const executor = new m.MessageActionExecutor(
		async () => {
			order.push("request");
			throw new Error("undo failed");
		},
		{
			onUndoOptimistic: () => order.push("optimistic"),
			onUndoFailed: () => order.push("failed"),
			onResync: () => order.push("resync"),
		},
	);
	await assert.rejects(executor.undo([record(state(), state({ read: true }))], "token"), /undo failed/);
	assert.deepEqual(order, ["optimistic", "request", "failed", "resync"]);
});

test("undo resyncs when the server reports stale or missing messages", async () => {
	const order = [];
	const executor = new m.MessageActionExecutor(
		async () => ({ ok: true, action: "read", restored: ["m1"], skipped: [{ id: "m2", reason: "stale" }] }),
		{
			onUndoOptimistic: () => order.push("optimistic"),
			onUndoCompleted: () => order.push("completed"),
			onResync: () => order.push("resync"),
		},
	);
	const result = await executor.undo([record(state(), state({ read: true }))], "token");
	assert.deepEqual(result.restored, ["m1"]);
	assert.deepEqual(order, ["optimistic", "completed", "resync"]);
});

test("actions on the same message are serialized, including an undo behind an apply", async () => {
	const events = [];
	let resolveApply;
	const executor = new m.MessageActionExecutor(async (body) => {
		events.push(`start:${body.op}`);
		if (body.op === "apply") {
			await new Promise((resolve) => { resolveApply = resolve; });
			events.push("end:apply");
			return applyResponse();
		}
		events.push("undo");
		return { ok: true, action: "read", restored: ["m1"], skipped: [] };
	});
	const apply = executor.run({ action: "read", messageIds: ["m1"] });
	await Promise.resolve();
	const undo = executor.undo([record(state(), state({ read: true }))], "token");
	await Promise.resolve();
	assert.deepEqual(events, ["start:apply"]);
	resolveApply();
	await Promise.all([apply, undo]);
	assert.deepEqual(events, ["start:apply", "end:apply", "start:undo", "undo"]);
});

test("unrelated messages still run concurrently and refetching cannot interleave with a same-id undo", async () => {
	const events = [];
	let resolveFirst;
	const executor = new m.MessageActionExecutor(async (body) => {
		events.push(`${body.op}:${body.messageIds?.[0]}`);
		if (body.messageIds?.[0] === "m1" && body.op === "apply") await new Promise((resolve) => { resolveFirst = resolve; });
		return body.op === "apply" ? applyResponse() : { ok: true, action: "read", restored: [], skipped: [] };
	});
	const first = executor.run({ action: "read", messageIds: ["m1"] });
	const second = executor.run({ action: "read", messageIds: ["m2"] });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(events.sort(), ["apply:m1", "apply:m2"]);
	resolveFirst();
	await Promise.all([first, second]);
});

test("membership changes are distinguished from read/star-only patches", () => {
	assert.equal(m.hasMembershipChange(record(state(), state({ read: true }))), false);
	assert.equal(m.hasMembershipChange(record(state(), state({ status: "archived" }))), true);
});

test("explicit read patches the list cache and emits an optimistic read event", async () => {
	const params = new URLSearchParams({ case: "read-patch" });
	await seedListCache(params, [{ id: "m1", read: true, starred: false }]);
	const unread = record(state({ read: true }), state({ read: false }));
	const events = captureEvents(() => {
		m.defaultMessageActionHooks.onApplied({ ok: true, action: "unread", applied: [unread], skipped: [] }, { notify: false });
	});
	assert.equal(m.peekMessageList(params).messages[0].read, false);
	assert.deepEqual(events.at(-1), { kind: "read", messageIds: ["m1"], read: false, threadTargets: [] });
	assert.equal(m.captureMessageFields(["m1"]).get("m1").read, false);
});

test("failed older undo restores the pre-click value, never the historical applied value", async () => {
	const params = new URLSearchParams({ case: "old-undo" });
	await seedListCache(params, [{ id: "m1", read: false, starred: false }]);
	// An older "mark read" snapshot (previous false, applied true) after a newer
	// "mark unread" has made the tab's current value false again.
	const olderRead = record(state({ read: false }), state({ read: true }));
	const captured = m.captureMessageFields(["m1"]);
	assert.equal(captured.get("m1").read, false);
	const events = captureEvents(() => {
		m.defaultMessageActionHooks.onUndoOptimistic([olderRead], captured);
		m.defaultMessageActionHooks.onUndoFailed([olderRead], captured);
	});
	assert.equal(m.peekMessageList(params).messages[0].read, false);
	assert.equal(events.at(-1).read, false);
});

test("skipped undo records return to the pre-click state instead of staying optimistic", async () => {
	const params = new URLSearchParams({ case: "skipped-undo" });
	await seedListCache(params, [{ id: "m1", read: false, starred: false }]);
	const unread = record(state({ read: true }), state({ read: false }));
	const captured = m.captureMessageFields(["m1"]);
	const events = captureEvents(() => {
		m.defaultMessageActionHooks.onUndoOptimistic([unread], captured);
		m.defaultMessageActionHooks.onUndoCompleted([unread], {
			ok: true,
			action: "unread",
			restored: [],
			skipped: [{ id: "m1", reason: "stale" }],
		}, captured);
	});
	assert.equal(m.peekMessageList(params).messages[0].read, false);
	assert.equal(events.at(-1).read, false);
});

test("grouped thread unread counts are patched once, not on both optimistic and completed undo", async () => {
	const params = new URLSearchParams({ case: "thread-undo" });
	await seedListCache(params, [{
		id: "m1",
		read: false,
		starred: false,
		threadMessageIds: ["m1", "m2", "m3"],
		threadUnread: 1,
	}]);
	const markRead = record(state({ read: false }), state({ read: true }));
	const events = captureEvents(() => {
		m.defaultMessageActionHooks.onApplied({ ok: true, action: "read", applied: [markRead], skipped: [] }, { notify: true });
		assert.equal(m.peekMessageList(params).messages[0].threadUnread, 0);
		m.defaultMessageActionHooks.onUndoOptimistic([markRead], new Map([["m1", { read: true }]]));
		assert.equal(m.peekMessageList(params).messages[0].threadUnread, 1);
		m.defaultMessageActionHooks.onUndoCompleted([markRead], {
			ok: true,
			action: "read",
			restored: ["m1"],
			skipped: [],
		}, new Map([["m1", { read: true }]]));
	});
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 1);
	assert.equal(events.length, 2);
});

test("star undo keeps a valid detail cache on success and invalidates it on failure", () => {
	m.clearKnownMessageFieldsForTests();
	m.primeMessageDetail({ id: "star-1", read: false, starred: false });
	const star = record(state({ starred: false }), state({ starred: true }), { id: "star-1" });
	const events = captureEvents(() => {
		m.defaultMessageActionHooks.onApplied({ ok: true, action: "star", applied: [star], skipped: [] }, { notify: true });
		assert.equal(m.getCachedMessageDetail("star-1").message.starred, true);
		const captured = m.captureMessageFields(["star-1"]);
		m.defaultMessageActionHooks.onUndoOptimistic([star], captured);
		assert.equal(m.getCachedMessageDetail("star-1").message.starred, false);
		m.defaultMessageActionHooks.onUndoCompleted([star], {
			ok: true,
			action: "star",
			restored: ["star-1"],
			skipped: [],
		}, captured);
		// A successful undo leaves the valid detail cache for the mounted reader.
		assert.equal(m.getCachedMessageDetail("star-1").message.starred, false);
		m.defaultMessageActionHooks.onUndoFailed([star], captured);
		// A failed undo drops the detail so the reader explicitly fetches server truth.
		assert.equal(m.getCachedMessageDetail("star-1"), undefined);
	});
	assert.ok(events.some((event) => event.kind === "patch" && event.patches?.[0]?.starred === false));
});

test("a stale list response cannot overwrite a read patch made while it was in flight", async () => {
	const originalFetch = globalThis.fetch;
	let resolveStale;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		if (calls === 1) return new Promise((resolve) => { resolveStale = resolve; });
		return Response.json({ messages: [{ id: "m1", read: true }], total: 1, limit: 25, offset: 0 });
	};
	try {
		const params = new URLSearchParams({ stale: "1" });
		const stale = cache.fetchMessageList(params, true);
		await Promise.resolve();
		// A read undo/refetch invalidates the request map before the old response lands.
		cache.invalidateMessageListRequests();
		resolveStale(Response.json({ messages: [{ id: "m1", read: false }], total: 1, limit: 25, offset: 0 }));
		await stale;
		assert.equal(cache.peekMessageList(params), undefined);
		const fresh = await cache.fetchMessageList(params);
		assert.equal(fresh.messages[0].read, true);
		assert.equal(calls, 2);
		cache.patchMessageFieldsInCaches([{ id: "m1", read: false }]);
		assert.equal(cache.peekMessageList(params).messages[0].read, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("every catalog carries the undo keys with identical placeholders", () => {
	const en = JSON.parse(readFileSync(join(root, "src/lib/i18n/en.json"), "utf8"));
	const undoKeys = Object.keys(en).filter((key) => key.startsWith("undo."));
	assert.ok(undoKeys.length >= 17);
	const placeholders = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();
	for (const file of readdirSync(join(root, "public", "locales")).filter((name) => name.endsWith(".json"))) {
		const catalog = JSON.parse(readFileSync(join(root, "public", "locales", file), "utf8"));
		for (const key of undoKeys) {
			assert.ok(typeof catalog[key] === "string" && catalog[key].trim().length > 0, `${file}: ${key} is missing`);
			assert.deepEqual(placeholders(catalog[key]), placeholders(en[key]), `${file}: ${key} placeholders`);
		}
	}
});

test("all message entry points use the shared action layer and keep undirected reads quiet", () => {
	const read = (path) => readFileSync(join(root, path), "utf8");
	assert.match(read("src/components/messages/utils.ts"), /performMessageAction/);
	assert.match(read("src/components/message-actions/utils.ts"), /performMessageAction/);
	assert.match(read("src/components/dashboard-nav-utils.ts"), /performMessageAction/);
	assert.match(read("src/components/messages/message-list-row-actions-utils.ts"), /performMessageAction/);
	for (const path of [
		"src/components/messages/bulk-message-action-bar.tsx",
		"src/components/message-actions/message-actions.tsx",
		"src/components/messages/thread-message-actions.tsx",
	]) {
		assert.match(read(path), /run(Bulk|Single)MessageAction/);
	}
	// Opening a message and expanding a thread are not explicit read toasts.
	assert.match(read("src/components/mark-read.ts"), /\/read`/);
	assert.doesNotMatch(read("src/components/mark-read.ts"), /undo-store|performMessageAction/);
	assert.match(read("src/components/messages/conversation-thread.tsx"), /runSingleMessageAction\(message\.id, "read", \{ undo: false \}\)/);
	// Block and unsubscribe outcomes are not offered as message undo.
	assert.match(read("src/components/message-actions/message-actions.tsx"), /runSingleMessageAction\(messageId, "trash", \{ undo: false \}\)/);
	// Undo lives in its own toast stack, not the single-slot compose notice.
	assert.match(read("src/app/(dashboard)/layout.tsx"), /<UndoToasts \/>/);
	assert.doesNotMatch(read("src/components/messages/undo-toasts.tsx"), /compose-context|useCompose/);
});
