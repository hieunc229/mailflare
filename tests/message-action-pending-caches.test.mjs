import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-action-pending-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const listeners = new Map();
globalThis.window = {
	addEventListener(type, listener) {
		const current = listeners.get(type) ?? [];
		current.push(listener);
		listeners.set(type, current);
	},
	removeEventListener(type, listener) {
		listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== listener));
	},
	dispatchEvent(event) {
		for (const listener of listeners.get(event.type) ?? []) listener(event);
		return true;
	},
	location: { assign() {} },
};
globalThis.localStorage = {
	getItem() { return null; },
	setItem() {},
	removeItem() {},
};
globalThis.document = { visibilityState: "visible", hidden: false, addEventListener() {}, removeEventListener() {} };

await build({
	stdin: {
		contents: `
			export { defaultMessageActionHooks, MessageActionRequestError } from "./src/lib/messages/actions/client.ts";
			export { MessageActionExecutor } from "./src/lib/messages/actions/executor.ts";
			export {
				fetchMessageList, peekMessageList, clearMessageListCache, invalidateMessageListRequests,
				patchMessageFieldsInCaches, markMessagesReadInCaches,
			} from "./src/hooks/utils.ts";
			export {
				fetchMessageCounts, clearMessageCountsCache,
			} from "./src/hooks/utils.ts";
			export {
				primeMessageDetail, getCachedMessageDetail, fetchCachedMessageDetail, patchCachedMessage,
				invalidateCachedMessageDetails, invalidateMessageDetailRequests, clearMessageDetailCache,
			} from "./src/lib/messages/detail-cache.ts";
			export {
				getCachedMessageThread, fetchMessageThread, clearMessageThreadCache,
				patchMessageThreadFieldsInCaches, invalidateMessageThreadRequests, isMessageThreadInvalidated,
			} from "./src/components/messages/message-thread-cache.ts";
			export {
				captureMessageFields, captureThreadUnread, clearKnownMessageFieldsForTests,
				setPendingOverlay, clearPendingOverlay, hasPendingOverlay, getPendingOverlayOwners,
				applyPendingToMessages, getKnownThreadUnread, subscribePendingOverlay,
				getVisibleMessageFields, getConversationLockKeys, getPendingThreadTargets, rememberThreadUnreadTargets, invalidateThreadUnreadTargets,
			} from "./src/lib/messages/field-store.ts";
		`,
		resolveDir: root,
		sourcefile: "message-action-pending-entry.ts",
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

const state = (overrides = {}) => ({
	status: "received",
	read: false,
	starred: false,
	folderId: null,
	snoozedUntil: null,
	...overrides,
});
const record = (id, previous, applied) => ({
	id,
	mailboxId: "mb1",
	previous: state(previous),
	applied: state(applied),
});
const success = (restored, skipped = []) => ({
	ok: true,
	action: "read",
	restored,
	skipped: skipped.map((id) => ({ id, reason: "stale" })),
});

const originalFetch = globalThis.fetch;
beforeEach(() => {
	m.clearMessageListCache();
	m.clearMessageDetailCache();
	m.clearMessageThreadCache();
	m.clearKnownMessageFieldsForTests();
	globalThis.fetch = originalFetch;
});

after(() => {
	globalThis.fetch = originalFetch;
	delete globalThis.window;
	delete globalThis.document;
	delete globalThis.localStorage;
});

async function seedList(params, messages) {
	globalThis.fetch = async () => Response.json({ messages, total: messages.length, limit: 25, offset: 0 });
	await m.fetchMessageList(params, true);
}

async function seedThread(anchor, messages) {
	globalThis.fetch = async () => Response.json({ threadId: "t1", messages });
	return m.fetchMessageThread(anchor);
}

let resolveQueued;

function deferredFetchResponse(payload) {
	let resolve;
	const fetch = new Promise((resolveResponse) => {
		resolve = () => resolveResponse(Response.json(payload));
	});
	globalThis.fetch = () => fetch;
	return resolve;
}

test("a queued list response and a later generic refresh apply the held undo overlay", async () => {
	const params = new URLSearchParams({ case: "held-undo" });
	await seedList(params, [{ id: "m1", read: true, starred: false }]);
	const undo = record("m1", { read: false }, { read: true });
	const captured = m.captureMessageFields(["m1"]);
	assert.equal(captured.get("m1").read, true);

	resolveQueued = deferredFetchResponse({ messages: [{ id: "m1", read: true }], total: 1, limit: 25, offset: 0 });
	const queued = m.fetchMessageList(params, true);
	await Promise.resolve();
	m.defaultMessageActionHooks.onUndoOptimistic([undo], captured);
	assert.equal(m.peekMessageList(params).messages[0].read, false);
	assert.equal(m.hasPendingOverlay(), true);

	// This request was already in flight when the undo painted its value.
	resolveQueued();
	const queuedResult = await queued;
	assert.equal(queuedResult.messages[0].read, false, "queued response must not repaint the server value");

	// A generic refresh started after the pending overlay is also safe.
	globalThis.fetch = async () => Response.json({ messages: [{ id: "m1", read: true }], total: 1, limit: 25, offset: 0 });
	const refreshed = await m.fetchMessageList(params, true);
	assert.equal(refreshed.messages[0].read, false);
	assert.equal(m.peekMessageList(params).messages[0].read, false);

	m.defaultMessageActionHooks.onUndoFailed([undo], captured);
	assert.equal(m.peekMessageList(params).messages[0].read, true, "failure rolls back to the pre-click value");
	assert.equal(m.hasPendingOverlay(), false);
});

test("a grouped row uses absolute targets and repeated desired values are no-ops", async () => {
	const params = new URLSearchParams({ case: "grouped-idempotent" });
	await seedList(params, [{
		id: "m1",
		read: false,
		starred: false,
		threadMessageIds: ["m1", "m2", "m3"],
		threadUnread: 1,
	}]);
	const read = record("m1", { read: false }, { read: true });
	const unread = record("m1", { read: true }, { read: false });

	m.defaultMessageActionHooks.onApplied({ ok: true, action: "read", applied: [read], skipped: [] }, { notify: true });
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 0);
	// The same desired value again cannot subtract another member.
	m.defaultMessageActionHooks.onApplied({ ok: true, action: "read", applied: [read], skipped: [] }, { notify: true });
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 0);

	m.defaultMessageActionHooks.onApplied({ ok: true, action: "unread", applied: [unread], skipped: [] }, { notify: true });
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 1);

	// An older read undo wants false, which is already the current value.
	const captured = m.captureMessageFields(["m1"]);
	const capturedThreads = m.captureThreadUnread(["m1"]);
	assert.equal(captured.get("m1").read, false);
	assert.equal(capturedThreads.get("m1"), 1);
	m.defaultMessageActionHooks.onUndoOptimistic([read], captured);
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 1, "pending undo must not increment a repeated value");
	m.defaultMessageActionHooks.onUndoFailed([read], captured);
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 1, "failed undo must roll back to the pre-click aggregate");
	assert.equal(m.hasPendingOverlay(), false);
});

test("grouped patching counts actual member transitions, not desired ids", async () => {
	const params = new URLSearchParams({ case: "grouped-members" });
	await seedList(params, [{
		id: "m1",
		read: false,
		starred: false,
		threadMessageIds: ["m1", "m2", "m3"],
		threadUnread: 1,
	}]);
	const patchReads = (read) => m.patchMessageFieldsInCaches(["m1", "m2", "m3"].map((id) => ({ id, read })));
	patchReads(true);
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 0);
	patchReads(true);
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 0);
	patchReads(false);
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 3);
	patchReads(false);
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 3);
});

test("thread and detail ingress apply a pending overlay to fresh server responses", async () => {
	const thread = [
		{ id: "t1", read: true, starred: true, textBody: "", htmlBody: "", attachments: [] },
	];
	await seedThread("anchor-1", thread);
	const star = record("t1", { starred: false }, { starred: true });
	const captured = m.captureMessageFields(["t1"]);
	m.defaultMessageActionHooks.onUndoOptimistic([star], captured);
	assert.equal(m.getCachedMessageThread("anchor-1")[0].starred, false);

	m.clearMessageThreadCache();
	assert.equal(m.hasPendingOverlay(), true);
	const refreshedThread = await m.fetchMessageThread("anchor-1");
	assert.equal(refreshedThread[0].starred, false);
	assert.equal(m.getCachedMessageThread("anchor-1")[0].starred, false);

	m.primeMessageDetail({ id: "d1", read: true, starred: true, threadId: null });
	const detailStar = record("d1", { starred: false }, { starred: true });
	const detailCaptured = m.captureMessageFields(["d1"]);
	m.defaultMessageActionHooks.onUndoOptimistic([detailStar], detailCaptured);
	assert.equal(m.getCachedMessageDetail("d1").message.starred, false);
	globalThis.fetch = async () => Response.json({ message: { id: "d1", read: true, starred: true } });
	const refreshedDetail = await m.fetchCachedMessageDetail("d1", true);
	assert.equal(refreshedDetail.message.starred, false);
	assert.equal(m.getCachedMessageDetail("d1").message.starred, false);
});

test("a settled undo invalidates every in-flight response without dropping the patched cache", async () => {
	const params = new URLSearchParams({ case: "settled-inflight" });
	await seedList(params, [{ id: "m1", read: true, starred: false }]);
	m.primeMessageDetail({ id: "d1", read: true, starred: false, threadId: null });
	const recordOne = record("m1", { read: false }, { read: true });
	const detailRecord = record("d1", { read: false }, { read: true });
	const captured = m.captureMessageFields(["m1", "d1"]);
	const listOwner = { pendingOwner: "undo-list" };
	const detailOwner = { pendingOwner: "undo-detail" };
	m.defaultMessageActionHooks.onUndoOptimistic([recordOne], captured, listOwner);
	m.defaultMessageActionHooks.onUndoOptimistic([detailRecord], captured, detailOwner);

	const resolveList = deferredFetchResponse({
		messages: [{ id: "m1", read: true }], total: 1, limit: 25, offset: 0,
	});
	const listRequest = m.fetchMessageList(params, true);
	await Promise.resolve();

	const resolveThread = deferredFetchResponse({
		threadId: "t1", messages: [{ id: "t1", read: true, starred: true, textBody: "", htmlBody: "", attachments: [] }],
	});
	const threadRequest = m.fetchMessageThread("missing-thread");
	const resolveDetail = deferredFetchResponse({ message: { id: "d1", read: true, starred: false } });
	const detailRequest = m.fetchCachedMessageDetail("d1", true);
	await Promise.resolve();

	m.defaultMessageActionHooks.onUndoCompleted([recordOne], success(["m1"]), captured, listOwner);
	m.defaultMessageActionHooks.onUndoCompleted([detailRecord], success(["d1"]), captured, detailOwner);

	resolveList();
	await listRequest;
	assert.equal(m.peekMessageList(params).messages[0].read, false, "stale list response cannot replace the patched cache");

	resolveDetail();
	await assert.rejects(detailRequest, /invalidated/);

	resolveThread();
	await assert.rejects(threadRequest, (error) => m.isMessageThreadInvalidated(error));
});

test("a grouped aggregate read never seeds the anchor member's individual state", async () => {
	const params = new URLSearchParams({ case: "grouped-anchor" });
	await seedList(params, [{
		id: "A",
		read: false,
		starred: false,
		threadMessageIds: ["A", "B"],
		threadUnread: 1,
	}]);
	assert.equal(
		m.getVisibleMessageFields("A").read,
		undefined,
		"the row's aggregate read flag says nothing about the anchor member",
	);
	assert.deepEqual(m.getConversationLockKeys(["A"]).sort(), ["A", "B"]);
});

test("undoes in one conversation serialize so a rejected aggregate is not stacked into the next", async () => {
	const params = new URLSearchParams({ case: "conversation-lock" });
	await seedList(params, [{
		id: "m1",
		read: true,
		starred: false,
		threadMessageIds: ["m1", "m2"],
		threadUnread: 0,
	}]);
	const tokens = [];
	let rejectFirst;
	let resolveSecond;
	const executor = new m.MessageActionExecutor((body) => {
		tokens.push(body.token);
		if (tokens.length === 1) {
			return new Promise((_resolve, reject) => {
				rejectFirst = () => reject(new m.MessageActionRequestError("stale", 409));
			});
		}
		return new Promise((resolve) => {
			resolveSecond = () => resolve({ ok: true, action: "read", restored: ["m2"], skipped: [] });
		});
	}, {
		...m.defaultMessageActionHooks,
		onResync() {},
	});
	const firstUndo = record("m1", { read: false }, { read: true });
	const secondUndo = record("m2", { read: false }, { read: true });

	const first = executor.undo([firstUndo], "token-a");
	const second = executor.undo([secondUndo], "token-b");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(tokens, ["token-a"], "the second conversation member waits for the first undo");

	rejectFirst();
	await assert.rejects(first, /stale/);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(tokens, ["token-a", "token-b"], "the next undo starts against the rolled-back aggregate");
	assert.equal(m.getVisibleMessageFields("m1").read, undefined, "the failed undo left no optimistic anchor state");
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 1);

	resolveSecond();
	await second;
	assert.equal(
		m.peekMessageList(params).messages[0].threadUnread,
		1,
		"the rejected first undo must not leave an extra unread behind",
	);
});

test("successful undos keep their settled aggregate when the list cache is gone", async () => {
	const params = new URLSearchParams({ case: "settled-aggregate" });
	await seedList(params, [{
		id: "A",
		read: true,
		starred: false,
		threadMessageIds: ["A", "B", "C"],
		threadUnread: 0,
	}]);
	for (const id of ["A", "B", "C"]) {
		m.primeMessageDetail({ id, read: true, starred: false, threadId: null });
	}
	const first = record("A", { read: false }, { read: true });
	const second = record("B", { read: false }, { read: true });
	const third = record("C", { read: false }, { read: true });
	let resolveThird;
	const executor = new m.MessageActionExecutor((body) => {
		const id = body.token === "token-a" ? "A" : body.token === "token-b" ? "B" : "C";
		if (body.token === "token-c") {
			return new Promise((resolve) => {
				resolveThird = () => resolve({ ok: true, action: "read", restored: [id], skipped: [] });
			});
		}
		return Promise.resolve({ ok: true, action: "read", restored: [id], skipped: [] });
	}, m.defaultMessageActionHooks);

	await executor.undo([first], "token-a");
	assert.equal(m.getKnownThreadUnread("A"), 1);
	assert.equal(m.peekMessageList(params), undefined, "the generic resync cleared the cached row");
	await executor.undo([second], "token-b");
	assert.equal(m.getKnownThreadUnread("A"), 2, "the second success starts from the settled first aggregate");
	assert.equal(m.peekMessageList(params), undefined);

	const thirdUndo = executor.undo([third], "token-c");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(m.getKnownThreadUnread("A"), 3);
	globalThis.fetch = async () => Response.json({
		messages: [{
			id: "A",
			read: false,
			starred: false,
			threadMessageIds: ["A", "B", "C"],
			threadUnread: 2,
		}],
		total: 1,
		limit: 25,
		offset: 0,
	});
	const background = await m.fetchMessageList(params, true);
	assert.equal(background.messages[0].threadUnread, 3, "the pending third undo overlays the background row");
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 3);

	resolveThird();
	await thirdUndo;
	assert.equal(m.getKnownThreadUnread("A"), 3, "the third success settles at the accumulated aggregate");
	globalThis.fetch = async () => Response.json({
		messages: [{
			id: "A",
			read: false,
			starred: false,
			threadMessageIds: ["A", "B", "C"],
			threadUnread: 3,
		}],
		total: 1,
		limit: 25,
		offset: 0,
	});
	const settled = await m.fetchMessageList(params, true);
	assert.equal(settled.messages[0].threadUnread, 3);
});

test("a failed undo does not commit its pending aggregate as the baseline", async () => {
	const params = new URLSearchParams({ case: "failed-aggregate" });
	await seedList(params, [{
		id: "A",
		read: true,
		starred: false,
		threadMessageIds: ["A", "B"],
		threadUnread: 0,
	}]);
	m.primeMessageDetail({ id: "A", read: true, starred: false, threadId: null });
	m.primeMessageDetail({ id: "B", read: true, starred: false, threadId: null });
	const first = record("A", { read: false }, { read: true });
	const executor = new m.MessageActionExecutor(async () => {
		throw new m.MessageActionRequestError("stale", 409);
	}, { ...m.defaultMessageActionHooks, onResync() {} });

	await assert.rejects(executor.undo([first], "token-fail"), /stale/);
	assert.equal(m.getKnownThreadUnread("A"), 0);
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 0);
});

test("an opening read beats a body response that started before it", async () => {
	m.primeMessageDetail({ id: "m1", read: false, starred: false, threadId: null });
	let resolveBody;
	globalThis.fetch = () => new Promise((resolve) => {
		resolveBody = () => resolve(Response.json({
			message: { id: "m1", read: false, starred: false },
			body: { textBody: "body", htmlBody: null },
		}));
	});
	const olderBody = m.fetchCachedMessageDetail("m1", true);
	await Promise.resolve();

	// The opening POST completes while the older body response is still held.
	m.patchCachedMessage("m1", { read: true });
	assert.equal(m.getCachedMessageDetail("m1").message.read, true);
	resolveBody();
	const reconciled = await olderBody;
	assert.equal(reconciled.message.read, true, "the completed read survives the older body response");
	assert.equal(reconciled.body.textBody, "body");
	assert.equal(m.getCachedMessageDetail("m1").message.read, true);

	// A later explicit unread is authoritative and must not be preserved away.
	m.patchCachedMessage("m1", { read: false });
	globalThis.fetch = async () => Response.json({
		message: { id: "m1", read: false, starred: false },
		body: { textBody: "body", htmlBody: null },
	});
	const unread = await m.fetchCachedMessageDetail("m1", true);
	assert.equal(unread.message.read, false);
	assert.equal(m.getCachedMessageDetail("m1").message.read, false);
});

test("a partial grouped undo rolls back only skipped members and keeps restored ones", async () => {
	const params = new URLSearchParams({ case: "partial-grouped-undo" });
	await seedList(params, [{
		id: "A",
		read: true,
		starred: false,
		threadMessageIds: ["A", "B"],
		threadUnread: 0,
	}]);
	// Both members were read before the undo; the grouped row aggregate alone
	// cannot establish that.
	m.primeMessageDetail({ id: "A", read: true, starred: false, threadId: null });
	m.primeMessageDetail({ id: "B", read: true, starred: false, threadId: null });
	const captured = m.captureMessageFields(["A", "B"]);
	const capturedThreads = m.captureThreadUnread(["A", "B"]);
	assert.equal(captured.get("A").read, true);
	assert.equal(captured.get("B").read, true);
	assert.equal(capturedThreads.get("A"), 0);

	const first = record("A", { read: false }, { read: true });
	const second = record("B", { read: false }, { read: true });
	const context = { pendingOwner: "partial-undo" };
	m.defaultMessageActionHooks.onUndoOptimistic([first, second], captured, context);
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 2);

	m.defaultMessageActionHooks.onUndoCompleted([first, second], {
		ok: true,
		action: "read",
		restored: ["A"],
		skipped: [{ id: "B", reason: "stale" }],
	}, captured, { ...context, capturedThreadUnread: capturedThreads });

	assert.equal(
		m.peekMessageList(params).messages[0].threadUnread,
		1,
		"the restored member stays unread while only the skipped member rolls back",
	);
	m.defaultMessageActionHooks.onResync?.(["A", "B"]);
	globalThis.fetch = async () => Response.json({
		messages: [{
			id: "A",
			read: false,
			starred: false,
			threadMessageIds: ["A", "B"],
			threadUnread: 1,
		}],
		total: 1,
		limit: 25,
		offset: 0,
	});
	const refreshed = await m.fetchMessageList(params, true);
	assert.equal(refreshed.messages[0].threadUnread, 1);
	assert.equal(m.peekMessageList(params).messages[0].threadUnread, 1);
});

test("owner-scoped overlays clear independently and notify subscribers", () => {
	let changes = 0;
	const unsubscribe = m.subscribePendingOverlay(() => { changes += 1; });
	m.setPendingOverlay("one", { messages: [{ id: "a1", read: true }] });
	assert.equal(m.getKnownThreadUnread("row"), undefined);
	assert.equal(m.applyPendingToMessages([{ id: "a1", read: false }])[0].read, true);
	m.setPendingOverlay("two", { messages: [{ id: "a1", read: false }] });
	assert.equal(m.applyPendingToMessages([{ id: "a1", read: true }])[0].read, false, "later owner wins");
	m.clearPendingOverlay("two");
	assert.equal(m.applyPendingToMessages([{ id: "a1", read: false }])[0].read, true);
	assert.deepEqual(m.getPendingOverlayOwners(), ["one"]);
	m.clearPendingOverlay("one");
	assert.equal(m.hasPendingOverlay(), false);
	assert.ok(changes >= 4);
	unsubscribe();
});
