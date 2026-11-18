import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-undo-toast-store-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;

await build({
	stdin: {
		contents: `
			export * from "./src/lib/messages/actions/undo-store.ts";
			export { AUTH_SESSION_CHANGED_EVENT } from "./src/lib/auth/client.ts";
		`,
		resolveDir: root,
		sourcefile: "undo-store-test-entry.ts",
	},
	outfile: join(directory, "store.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});

const store = await import(pathToFileURL(join(directory, "store.mjs")).href);

const originalNow = Date.now;
let now = 0;
let nextTimerId = 0;
let pendingTimers = [];

window.setTimeout = (callback, delay = 0) => {
	const id = ++nextTimerId;
	pendingTimers.push({ id, at: now + Number(delay), callback });
	return id;
};
window.clearTimeout = (id) => {
	pendingTimers = pendingTimers.filter((timer) => timer.id !== id);
};

function advance(ms) {
	now += ms;
	for (;;) {
		const due = pendingTimers
			.filter((timer) => timer.at <= now)
			.sort((a, b) => a.at - b.at || a.id - b.id)[0];
		if (!due) return;
		pendingTimers = pendingTimers.filter((timer) => timer !== due);
		due.callback();
	}
}

Date.now = () => now;

const state = (overrides = {}) => ({
	status: "received",
	read: false,
	starred: false,
	folderId: null,
	snoozedUntil: null,
	...overrides,
});

const record = (id) => ({
	id,
	mailboxId: "mb1",
	previous: state(),
	applied: state({ read: true }),
});

const add = (id, action = "read", records = [record(`m${id}`)]) =>
	store.showUndoToast({
		action,
		records,
		undoToken: `token-${id}`,
	});

beforeEach(() => {
	pendingTimers = [];
	document.body.replaceChildren();
	store.resetUndoToastsForTests();
});

after(() => {
	Date.now = originalNow;
	dom.window.close();
	delete globalThis.window;
	delete globalThis.document;
	delete globalThis.HTMLElement;
	delete globalThis.Node;
	delete globalThis.Event;
});

test("an applied action starts a 20 second window and pauses while held", () => {
	assert.equal(store.UNDO_WINDOW_MS, 20_000);
	const id = add(1);
	assert.ok(id);
	assert.deepEqual(store.getUndoToasts().map((entry) => entry.id), [id]);

	advance(5_000);
	store.pauseUndoToast(id, "hover");
	advance(60_000);
	assert.equal(store.getUndoToasts().length, 1, "a hovered toast stays");

	store.resumeUndoToast(id, "hover");
	advance(14_999);
	assert.equal(store.getUndoToasts().length, 1);
	advance(1);
	assert.equal(store.getUndoToasts().length, 0);
});

test("a hidden tab pauses every idle countdown until it becomes visible", () => {
	const first = add(1);
	const second = add(2);
	advance(4_000);

	let hidden = true;
	Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
	document.dispatchEvent(new window.Event("visibilitychange"));
	advance(90_000);
	assert.equal(store.getUndoToasts().length, 2, "nothing expires in the background");

	hidden = false;
	document.dispatchEvent(new window.Event("visibilitychange"));
	advance(15_999);
	assert.deepEqual(store.getUndoToasts().map((entry) => entry.id), [first, second]);
	advance(1);
	assert.equal(store.getUndoToasts().length, 0);
});

test("a global interaction hold pauses every idle countdown until interaction ends", () => {
	const first = add(1);
	const second = add(2);
	advance(3_000);
	store.pauseUndoToasts("modal");
	advance(90_000);
	assert.deepEqual(store.getUndoToasts().map((entry) => entry.id), [first, second]);

	store.resumeUndoToasts("modal");
	advance(16_999);
	assert.equal(store.getUndoToasts().length, 2);
	advance(1);
	assert.equal(store.getUndoToasts().length, 0);
});

test("expiry never removes a toast that owns keyboard focus", () => {
	const id = add(1);
	const holder = document.createElement("div");
	holder.dataset.undoToastId = String(id);
	const button = document.createElement("button");
	button.textContent = "Undo";
	holder.appendChild(button);
	document.body.appendChild(holder);
	button.focus();

	advance(store.UNDO_WINDOW_MS);
	assert.equal(store.getUndoToasts().length, 1, "the focused toast remains");
	assert.equal(store.getUndoToasts()[0].status, "idle");

	button.blur();
	store.resumeUndoToast(id, "focus");
	advance(0);
	assert.equal(store.getUndoToasts().length, 0, "it expires after focus leaves");
});

test("visible toasts stay capped while active entries queue, and queued timers start on promotion", () => {
	const ids = [1, 2, 3, 4, 5, 6, 7].map((id) => add(id, id % 2 ? "read" : "star"));
	assert.deepEqual(store.getUndoToasts().map((entry) => entry.id), ids.slice(0, 4));
	assert.deepEqual(store.getQueuedUndoToasts().map((entry) => entry.id), ids.slice(4));
	assert.deepEqual(store.getQueuedUndoToasts().map((entry) => entry.action), ["read", "star", "read"]);
	assert.equal(store.getUndoAnnouncements().length, 4, "queued notices are not announced before they are visible");

	advance(store.UNDO_WINDOW_MS);
	assert.deepEqual(store.getUndoToasts().map((entry) => entry.id), ids.slice(4));
	assert.deepEqual(store.getQueuedUndoToasts(), []);

	advance(store.UNDO_WINDOW_MS - 1);
	assert.equal(store.getUndoToasts().length, 3);
	advance(1);
	assert.equal(store.getUndoToasts().length, 0);
});

test("a queued notice is announced only when it takes a visible slot", () => {
	const ids = [1, 2, 3, 4, 5].map((id) => add(id));
	assert.equal(store.getUndoAnnouncements().length, 4);

	store.dismissUndoToast(ids[0]);
	assert.deepEqual(store.getUndoToasts().map((entry) => entry.id), ids.slice(1));
	const announcement = store.getUndoAnnouncements().at(-1);
	assert.equal(announcement.kind, "applied");
	assert.equal(announcement.action, "read");
});

test("queued notices expire before their signed token can age out", () => {
	for (const id of [1, 2, 3, 4]) add(id);
	const queuedId = add(5);
	assert.equal(store.getQueuedUndoToasts().length, 1);
	assert.ok(store.QUEUE_MAX_AGE_MS <= 10 * 60_000);
	assert.equal(store.getUndoAnnouncements().length, 4);

	store.pauseUndoToasts("test-hold");
	advance(store.QUEUE_MAX_AGE_MS - 1);
	assert.deepEqual(store.getQueuedUndoToasts().map((entry) => entry.id), [queuedId]);
	advance(1);
	assert.equal(store.getQueuedUndoToasts().length, 0, "a stale queued token is not kept forever");
	assert.equal(store.getUndoToasts().length, 4);
	assert.equal(store.getUndoAnnouncements().length, 4, "an entry that never became visible is not announced");
	store.resumeUndoToasts("test-hold");
});

test("terminal receipts yield a visible slot when a new action needs one", () => {
	const ids = [1, 2, 3, 4].map((id) => add(id));
	for (const id of ids) {
		store.beginUndoToast(id);
		store.failUndoToast(id, { kind: "stale", retryable: false });
	}
	assert.equal(store.getUndoToasts().filter((entry) => entry.status === "failed").length, 4);

	const fresh = add(5);
	assert.deepEqual(
		store.getUndoToasts().map((entry) => entry.id),
		[ids[1], ids[2], ids[3], fresh],
		"the oldest failure acknowledgement is retired, the newest receipt remains",
	);
	assert.equal(store.getUndoToasts().filter((entry) => entry.status === "failed").length, 3);
	assert.equal(store.getUndoAnnouncements().at(-1).kind, "applied");
});

test("pressure never retires a retryable failure acknowledgement", () => {
	const ids = [1, 2, 3, 4].map((id) => add(id));
	for (const id of ids) {
		store.beginUndoToast(id);
		store.failUndoToast(id, { kind: "server", retryable: true });
	}

	const fresh = add(5);
	assert.deepEqual(store.getUndoToasts().map((entry) => entry.id), ids);
	assert.deepEqual(store.getQueuedUndoToasts().map((entry) => entry.id), [fresh]);
});

test("pressure never retires a focused receipt, and retires it after focus leaves", () => {
	const ids = [1, 2, 3, 4].map((id) => add(id));
	store.beginUndoToast(ids[0]);
	store.failUndoToast(ids[0], { kind: "stale", retryable: false });
	const holder = document.createElement("div");
	holder.dataset.undoToastId = String(ids[0]);
	const button = document.createElement("button");
	holder.appendChild(button);
	document.body.appendChild(holder);
	button.focus();

	const fresh = add(5);
	assert.deepEqual(store.getUndoToasts().map((entry) => entry.id), ids);
	assert.deepEqual(store.getQueuedUndoToasts().map((entry) => entry.id), [fresh]);
	assert.equal(document.activeElement, button);

	button.blur();
	const next = add(6);
	assert.equal(store.getUndoToasts()[0].id, ids[1]);
	assert.deepEqual(store.getUndoToasts().map((entry) => entry.id), ids.slice(1).concat(fresh));
	assert.deepEqual(store.getQueuedUndoToasts().map((entry) => entry.id), [next]);
});

test("promotion prunes a queued notice whose expiry timer was throttled", () => {
	const ids = [1, 2, 3, 4].map((id) => add(id));
	const queuedId = add(5);
	now += store.QUEUE_MAX_AGE_MS + 1;
	store.dismissUndoToast(ids[0]);
	assert.deepEqual(store.getQueuedUndoToasts(), []);
	assert.equal(store.getUndoToasts().some((entry) => entry.id === queuedId), false);
	assert.deepEqual(store.getUndoToasts().map((entry) => entry.id), ids.slice(1));
});

test("a terminal receipt turning while an undo is queued promotes the active undo and keeps one ack", () => {
	const ids = [1, 2, 3, 4].map((id) => add(id));
	const queuedId = add(5);
	store.beginUndoToast(ids[0]);
	store.failUndoToast(ids[0], { kind: "stale", retryable: false });
	assert.deepEqual(store.getUndoToasts().map((entry) => entry.id), ids);
	assert.equal(store.getQueuedUndoToasts()[0].id, queuedId, "the first failure receipt is acknowledged");

	store.beginUndoToast(ids[1]);
	store.failUndoToast(ids[1], { kind: "stale", retryable: false });
	assert.deepEqual(store.getUndoToasts().map((entry) => entry.id), [ids[1], ids[2], ids[3], queuedId]);
	assert.equal(store.getQueuedUndoToasts().length, 0);
});

test("the overflow queue is bounded but never replaces the visible stack", () => {
	const ids = Array.from({ length: 4 + store.UNDO_TOAST_LIMITS.queued + 1 }, (_, index) => add(index + 1));
	assert.equal(store.getUndoToasts().length, store.UNDO_TOAST_LIMITS.visible);
	assert.equal(store.getQueuedUndoToasts().length, store.UNDO_TOAST_LIMITS.queued);
	assert.deepEqual(store.getUndoToasts().map((entry) => entry.id), ids.slice(0, 4));
	assert.deepEqual(
		store.getQueuedUndoToasts().map((entry) => entry.id),
		ids.slice(5),
		"only the oldest queued entry is dropped when the spillover is full",
	);
});

test("failed undos stay until dismissed, and retryable failures can start again", () => {
	const id = add(1);
	store.beginUndoToast(id);
	assert.equal(store.getUndoToasts()[0].status, "undoing");

	store.failUndoToast(id, { kind: "server", retryable: true });
	advance(120_000);
	assert.equal(store.getUndoToasts().length, 1);
	assert.deepEqual(store.getUndoToasts()[0].failure, { kind: "server", retryable: true });
	assert.equal(store.getUndoAnnouncements().at(-1).kind, "undo-failed");

	store.beginUndoToast(id);
	assert.equal(store.getUndoToasts()[0].status, "undoing");
	assert.equal(store.getUndoToasts()[0].failure, undefined);

	store.partialUndoToast(id, { restored: 3, skipped: 2, skippedReasons: ["failed"] });
	advance(120_000);
	assert.equal(store.getUndoToasts()[0].status, "partial");
	assert.equal(store.getUndoToasts()[0].restored, 3);
	assert.equal(store.getUndoToasts()[0].undoSkipped, 2);
	assert.deepEqual(store.getUndoToasts()[0].undoSkippedReasons, ["failed"]);
	assert.equal(store.getUndoAnnouncements().at(-1).kind, "undo-partial");

	store.completeUndoToast(id);
	assert.equal(store.getUndoToasts().length, 0);
	assert.equal(store.getUndoAnnouncements().at(-1).kind, "undo-success");
});

test("an auth session change clears visible and queued toasts, timers and announcements", () => {
	const first = add(1);
	const second = add(2);
	add(3);
	add(4);
	add(5);
	assert.equal(store.getUndoToasts().length, 4);
	assert.equal(store.getQueuedUndoToasts().length, 1);

	window.dispatchEvent(new window.Event(store.AUTH_SESSION_CHANGED_EVENT));
	assert.equal(store.getUndoToasts().length, 0);
	assert.equal(store.getQueuedUndoToasts().length, 0);
	assert.equal(store.getUndoAnnouncements().length, 0);
	advance(store.UNDO_WINDOW_MS);
	assert.equal(store.getUndoToasts().length, 0, "old timers cannot resurrect the prior session");

	const next = add(9);
	assert.ok(next > first && next > second, "ids stay monotonic so a late response cannot hit a reused toast");
});

test("the announcement log keeps applied, success, partial and failure events in order", () => {
	const first = add(1);
	const second = add(2, "star");
	assert.deepEqual(store.getUndoAnnouncements().map((item) => item.kind), ["applied", "applied"]);

	store.beginUndoToast(first);
	store.completeUndoToast(first);
	store.beginUndoToast(second);
	store.partialUndoToast(second, { restored: 1, skipped: 0 });

	const kinds = store.getUndoAnnouncements().map((item) => item.kind);
	assert.deepEqual(kinds, ["applied", "applied", "undo-success", "undo-partial"]);
	assert.equal(store.getUndoAnnouncements().at(-1).count, 1);
});
