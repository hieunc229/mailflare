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
				MessageActionExecutor, MessageActionRequestError, getChangedRecords, readPatchGroups, hasMembershipChange,
			} from "./src/lib/messages/actions/executor.ts";
			export { signUndoToken, verifyUndoToken } from "./src/lib/messages/actions/token.ts";
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
	const payload = { v: 1, issuedAt: Date.now(), action: "archive", records: [record(state(), state({ status: "archived" }))] };
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
	assert.deepEqual([...m.readPatchGroups(result.applied, "applied")], [[true, ["m1"]]]);
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
		cache.patchMessagesInCaches(["m1"], { read: false });
		assert.equal(cache.peekMessageList(params).messages[0].read, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("every catalog carries the undo keys with identical placeholders", () => {
	const en = JSON.parse(readFileSync(join(root, "src/lib/i18n/en.json"), "utf8"));
	const undoKeys = Object.keys(en).filter((key) => key.startsWith("undo."));
	assert.ok(undoKeys.length >= 17);
	for (const file of readdirSync(join(root, "public", "locales")).filter((name) => name.endsWith(".json"))) {
		const catalog = JSON.parse(readFileSync(join(root, "public", "locales", file), "utf8"));
		for (const key of undoKeys) assert.equal(catalog[key], en[key], `${file}: ${key}`);
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
	// Star sends the desired state through the shared layer, and the legacy endpoint stays a toggle.
	assert.match(read("src/app/api/messages/[messageId]/star/route.ts"), /payload\.starred \?\? !message\.starred/);
	// Undo lives in its own toast stack, not the single-slot compose notice.
	assert.match(read("src/app/(dashboard)/layout.tsx"), /<UndoToasts \/>/);
	assert.doesNotMatch(read("src/components/messages/undo-toasts.tsx"), /compose-context|useCompose/);
});
