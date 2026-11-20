import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-promotions-ui-"));
after(() => rmSync(temp, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export * from "./src/lib/promotions/ui-utils.ts";
			export { promotionsFolderConfig } from "./src/components/messages/message-folder-configs.ts";
			export { getMessageQueryParams } from "./src/hooks/utils.ts";
			export { applyCountsDelta } from "./src/hooks/counts-delta-utils.ts";
			export { countsDeltaForNewMessage, parseNewMessageEvent } from "./src/hooks/message-realtime-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "entry.ts",
		loader: "ts",
	},
	outfile: join(temp, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	alias: { "@": join(root, "src") },
	packages: "external",
	external: ["react", "lucide-react"],
	logLevel: "silent",
});
const u = await import(pathToFileURL(join(temp, "entry.mjs")).href);

test("the nav entry shows only when some mailbox has Promotions on", () => {
	assert.equal(u.hasActivePromotions(undefined), false);
	assert.equal(u.hasActivePromotions({}), false);
	assert.equal(u.hasActivePromotions({ a: "off" }), false);
	assert.equal(u.hasActivePromotions({ a: "show" }), true);
	assert.equal(u.hasActivePromotions({ a: "off", b: "separate" }), true);
});

test("only full access may change the mode", () => {
	assert.equal(u.canManagePromotions("full_access"), true);
	for (const p of ["read_only", "send_as", "send_on_behalf", undefined]) assert.equal(u.canManagePromotions(p), false);
});

test("backfill notice: idle and done say nothing about progress except done", () => {
	assert.deepEqual(u.getBackfillNotice({ status: "idle", scanned: 0 }), { kind: "none" });
	assert.deepEqual(u.getBackfillNotice(null), { kind: "none" });
	assert.deepEqual(u.getBackfillNotice({ status: "pending", scanned: 0 }), { kind: "pending", key: "settings.promotions.backfillPending" });
	assert.deepEqual(u.getBackfillNotice({ status: "running", scanned: 1200 }), { kind: "running", key: "settings.promotions.backfillRunning", vars: { count: 1200 } });
	assert.deepEqual(u.getBackfillNotice({ status: "done", scanned: 40 }), { kind: "done", key: "settings.promotions.backfillDone", vars: { count: 40 } });
});

test("a failed backfill carries the error and offers a retry", () => {
	assert.deepEqual(u.getBackfillNotice({ status: "failed", scanned: 5, error: "boom" }), { kind: "failed", key: "settings.promotions.backfillFailed", error: "boom", retry: true });
	assert.deepEqual(u.getBackfillNotice({ status: "failed", scanned: 5 }), { kind: "failed", key: "settings.promotions.backfillFailed", error: null, retry: true });
});

test("a 409 MIGRATION_REQUIRED maps to its own message", () => {
	assert.equal(u.getModeErrorKey(409, "MIGRATION_REQUIRED"), "settings.promotions.migrationRequired");
	assert.equal(u.getModeErrorKey(403, undefined), "settings.promotions.forbidden");
	assert.equal(u.getModeErrorKey(500, undefined), "settings.promotions.saveFailed");
	assert.equal(u.getModeErrorKey(409, "OTHER"), "settings.promotions.saveFailed");
});

test("the Promotions folder config", () => {
	assert.equal(u.promotionsFolderConfig.folder, "promotions");
	assert.equal(u.promotionsFolderConfig.hrefPrefix, "/promotions");
	assert.equal(u.promotionsFolderConfig.titleKey, "navigation.promotions");
	assert.equal(u.promotionsFolderConfig.emptyTextKey, "folder.empty.promotions");
});

test("the list query for Promotions asks for category=promotions on received mail", () => {
	const params = u.getMessageQueryParams("promotions", "mb1", { limit: 25 });
	assert.equal(params.get("category"), "promotions");
	assert.equal(params.get("status"), "received");
	assert.equal(params.get("direction"), "inbound");
	assert.equal(params.get("mailboxId"), "mb1");
	assert.equal(u.getMessageQueryParams("inbox").get("category"), null);
});

test("counts deltas move only the folder they name", () => {
	const counts = { folders: { inbox: { total: 5, unread: 3 }, promotions: { total: 2, unread: 1 } }, customFolders: {}, mailboxes: [] };
	const next = u.applyCountsDelta(counts, { promotionsUnreadDelta: 2 });
	assert.equal(next.folders.promotions.unread, 3);
	assert.equal(next.folders.inbox.unread, 3);
	assert.equal(u.applyCountsDelta(counts, { inboxUnreadDelta: -9 }).folders.inbox.unread, 0);
	assert.equal(u.applyCountsDelta(counts, {}), counts);
});

test("a promotions new_message event bumps Promotions unread only", () => {
	const event = { type: "new_message", messageId: "m", mailboxId: "b", from: "a@b.c", fromName: null, subject: null };
	assert.deepEqual(u.countsDeltaForNewMessage({ ...event, category: "promotions" }), { promotionsUnreadDelta: 1 });
	assert.equal(u.countsDeltaForNewMessage(event), null);
});

test("parseNewMessageEvent keeps the promotions category and drops unknown ones", () => {
	const base = { type: "new_message", messageId: "m", mailboxId: "b", from: "a@b.c" };
	assert.equal(u.parseNewMessageEvent(JSON.stringify({ ...base, category: "promotions" })).category, "promotions");
	assert.equal(u.parseNewMessageEvent(JSON.stringify({ ...base, category: "weird" })).category, undefined);
	assert.equal(u.parseNewMessageEvent(JSON.stringify(base)).category, undefined);
});

test("unread flips move the counts of the folders the row is listed in", () => {
	assert.deepEqual(u.unreadDeltas({ folder: "inbox", mode: undefined, category: null }, -1), { inboxUnreadDelta: -1 });
	assert.deepEqual(u.unreadDeltas({ folder: "inbox", mode: "off", category: "promotions" }, -1), { inboxUnreadDelta: -1 });
	assert.deepEqual(u.unreadDeltas({ folder: "inbox", mode: "show", category: "promotions" }, -1), { inboxUnreadDelta: -1, promotionsUnreadDelta: -1 });
	assert.deepEqual(u.unreadDeltas({ folder: "inbox", mode: "show", category: "primary" }, 1), { inboxUnreadDelta: 1 });
	assert.deepEqual(u.unreadDeltas({ folder: "promotions", mode: "show", category: "promotions" }, -1), { promotionsUnreadDelta: -1, inboxUnreadDelta: -1 });
	assert.deepEqual(u.unreadDeltas({ folder: "promotions", mode: "separate", category: "promotions" }, -2), { promotionsUnreadDelta: -2 });
	assert.equal(u.unreadDeltas({ folder: "promotions", mode: "off" }, -1), null);
	assert.equal(u.unreadDeltas({ folder: "inbox", folderId: "f1" }, -1), null);
	assert.equal(u.unreadDeltas({ folder: "archived" }, -1), null);
	assert.equal(u.unreadDeltas({ folder: "inbox" }, 0), null);
});

test("deltas merge and negate", () => {
	assert.deepEqual(u.mergeUnreadDeltas({ inboxUnreadDelta: -1 }, { inboxUnreadDelta: -1, promotionsUnreadDelta: -1 }), { inboxUnreadDelta: -2, promotionsUnreadDelta: -1 });
	assert.equal(u.mergeUnreadDeltas(null, null), null);
	assert.deepEqual(u.negateUnreadDeltas({ inboxUnreadDelta: -2, promotionsUnreadDelta: -1 }), { inboxUnreadDelta: 2, promotionsUnreadDelta: 1 });
	assert.equal(u.negateUnreadDeltas(null), null);
});
