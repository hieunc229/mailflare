import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-unread-bundle-"));
await build({
	stdin: {
		contents: `
			export { getInboxUnreadDeltas, getUnreadFlipCount } from "./src/components/messages/utils.ts";
			export { PartialDeleteError, throwIfDeleteSkipped } from "./src/lib/messages/permanent-delete-utils.ts";
			export { deltaAppliesToMailbox } from "./src/hooks/message-counts-delta.ts";
		`,
		resolveDir: root,
		sourcefile: "unread-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { deltaAppliesToMailbox, getInboxUnreadDeltas, getUnreadFlipCount, PartialDeleteError, throwIfDeleteSkipped } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
rmSync(bundleDirectory, { recursive: true, force: true });

const single = (read, direction = "inbound") => ({ direction, read });
const grouped = (threadUnread, size) => ({ direction: "inbound", read: threadUnread === 0, threadUnread, threadMessageIds: Array.from({ length: size }, (_, index) => `m${index}`) });

test("a single unread inbound message flips once", () => {
	assert.equal(getUnreadFlipCount(single(false), true), 1);
	assert.equal(getUnreadFlipCount(single(true), false), 1);
});

test("a message that already has the requested state flips nothing", () => {
	assert.equal(getUnreadFlipCount(single(true), true), 0);
	assert.equal(getUnreadFlipCount(single(false), false), 0);
});

test("outbound messages never count towards unread", () => {
	assert.equal(getUnreadFlipCount(single(false, "outbound"), true), 0);
	assert.equal(getUnreadFlipCount(single(true, "outbound"), false), 0);
});

test("a conversation row flips every unread message when marked read", () => {
	assert.equal(getUnreadFlipCount(grouped(2, 5), true), 2);
	assert.equal(getUnreadFlipCount(grouped(0, 5), true), 0);
});

test("a conversation row flips every read message when marked unread", () => {
	assert.equal(getUnreadFlipCount(grouped(0, 4), false), 4);
	assert.equal(getUnreadFlipCount(grouped(1, 4), false), 3);
	assert.equal(getUnreadFlipCount(grouped(4, 4), false), 0);
});

test("a skipped permanent delete is reported after the list is told to refresh", async () => {
	const events = [];
	globalThis.window = { dispatchEvent: (event) => events.push(event.type) };
	try {
		await throwIfDeleteSkipped(Response.json({ ok: true, deleted: 1, skipped: 2 }), "read");
		await throwIfDeleteSkipped(Response.json({ ok: true, deleted: 3, skipped: 0 }), "delete");
		assert.deepEqual(events, []);
		await assert.rejects(
			throwIfDeleteSkipped(Response.json({ ok: true, deleted: 1, skipped: 2 }), "delete"),
			(error) => error instanceof PartialDeleteError && error.skipped === 2,
		);
		assert.deepEqual(events, ["mailflare:messages-changed"]);
	} finally {
		delete globalThis.window;
	}
});

test("read and unread deltas are split by mailbox", () => {
	const rows = [
		{ mailboxId: "support", ...single(false) },
		{ mailboxId: "billing", ...single(false) },
		{ mailboxId: "support", ...grouped(2, 3) },
		{ mailboxId: "billing", ...single(true) },
	];
	assert.deepEqual(getInboxUnreadDeltas(rows, true), [
		{ mailboxId: "support", inboxUnreadDelta: -3 },
		{ mailboxId: "billing", inboxUnreadDelta: -1 },
	]);
	assert.deepEqual(getInboxUnreadDeltas(rows, false), [
		{ mailboxId: "support", inboxUnreadDelta: 1 },
		{ mailboxId: "billing", inboxUnreadDelta: 1 },
	]);
	assert.deepEqual(getInboxUnreadDeltas([{ mailboxId: "support", ...single(true) }], true), [], "no change, no delta");
});

test("a count delta reaches only the counts that include its mailbox", () => {
	const billing = { inboxUnreadDelta: -1, mailboxId: "billing" };
	assert.equal(deltaAppliesToMailbox(billing, "billing"), true);
	assert.equal(deltaAppliesToMailbox(billing, "support"), false);
	assert.equal(deltaAppliesToMailbox(billing, null), true, "all-mailbox counts include every mailbox");
	assert.equal(deltaAppliesToMailbox(billing, undefined), true);
	assert.equal(deltaAppliesToMailbox({ inboxUnreadDelta: -1 }, "support"), true, "a delta without a mailbox applies everywhere, as before");
	assert.equal(deltaAppliesToMailbox({ inboxUnreadDelta: -1, mailboxId: null }, "support"), true);
});
