import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-action-timeout-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const events = [];
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
		events.push(event.detail);
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
			export {
				messageActionExecutor, defaultMessageActionHooks, MessageActionRequestError,
				setMessageActionTransportTimeoutForTests,
			} from "./src/lib/messages/actions/client.ts";
			export {
				fetchMessageList, peekMessageList, clearMessageListCache, clearMessageCountsCache,
			} from "./src/hooks/utils.ts";
			export {
				primeMessageDetail, getCachedMessageDetail, fetchCachedMessageDetail, clearMessageDetailCache,
			} from "./src/lib/messages/detail-cache.ts";
			export { clearMessageThreadCache } from "./src/components/messages/message-thread-cache.ts";
			export {
				captureMessageFields, clearKnownMessageFieldsForTests, hasPendingOverlay,
			} from "./src/lib/messages/field-store.ts";
		`,
		resolveDir: root,
		sourcefile: "message-action-pending-timeout-entry.ts",
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
const record = (previous, applied) => ({
	id: "m1",
	mailboxId: "mb1",
	previous: state(previous),
	applied: state(applied),
});

const originalFetch = globalThis.fetch;
beforeEach(() => {
	events.length = 0;
	m.clearMessageListCache();
	m.clearMessageDetailCache();
	m.clearMessageThreadCache();
	m.clearKnownMessageFieldsForTests();
	globalThis.fetch = originalFetch;
	m.setMessageActionTransportTimeoutForTests(20);
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

function holdUntilAborted() {
	globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
		init.signal.addEventListener("abort", () => {
			const error = new Error("The operation was aborted");
			error.name = "AbortError";
			reject(error);
		});
	});
}

test("an apply timeout reports a retryable error, cleans up, and resyncs", async () => {
	holdUntilAborted();
	const promise = m.messageActionExecutor.run({ action: "read", messageIds: ["m1"] });
	await assert.rejects(promise, (error) => {
		assert.equal(error instanceof m.MessageActionRequestError, true);
		assert.equal(error.status, 408, "the toast maps 408 to a retryable server failure");
		return true;
	});
	assert.equal(m.hasPendingOverlay(), false);
	const last = events.at(-1);
	assert.equal(last ?? undefined, undefined, "the generic resync event carries no field patch");
});

test("an undo timeout does not paint the historical pre-click state over an uncertain server result", async () => {
	const params = new URLSearchParams({ case: "undo-timeout" });
	await seedList(params, [{ id: "m1", read: true, starred: false }]);
	m.primeMessageDetail({ id: "m1", read: true, starred: false, threadId: null });
	const undo = record({ read: false }, { read: true });
	const captured = m.captureMessageFields(["m1"]);
	assert.equal(captured.get("m1").read, true);

	holdUntilAborted();
	const promise = m.messageActionExecutor.undo([undo], "token");
	await assert.rejects(promise, (error) => {
		assert.equal(error instanceof m.MessageActionRequestError, true);
		assert.equal(error.status, 408);
		return true;
	});

	assert.equal(m.hasPendingOverlay(), false);
	assert.equal(m.peekMessageList(params), undefined, "the uncertain list cache is dropped for the resync");
	assert.equal(m.getCachedMessageDetail("m1"), undefined, "the reader cache is dropped for the resync");
	// The optimistic undo event is the only read patch. No historical rollback
	// (read true) may follow a timeout, because the server may have committed.
	const readEvents = events.filter((detail) => detail?.kind === "read");
	assert.equal(readEvents.length, 1);
	assert.equal(readEvents[0].read, false);
	assert.equal(events.at(-1) ?? undefined, undefined, "undo failure ends with the authoritative resync event");
});
