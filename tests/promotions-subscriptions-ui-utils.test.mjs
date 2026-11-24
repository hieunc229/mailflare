import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-subscriptions-ui-"));
after(() => rmSync(temp, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export * from "./src/lib/promotions/subscriptions-ui-utils.ts";`,
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
	logLevel: "silent",
});
const u = await import(pathToFileURL(join(temp, "entry.mjs")).href);

const row = (extra = {}) => ({
	senderAddress: "news@acme.com",
	displayName: "Acme News",
	total: 12,
	lastReceived: "2026-11-18T10:00:00.000Z",
	readRate: 25,
	latestMessageId: "msg_1",
	canUnsubscribe: true,
	categoryOverride: null,
	unsubscribedAt: null,
	stillSending: false,
	...extra,
});

test("read rate is a clamped whole percent", () => {
	assert.equal(u.formatReadRate(25), "25%");
	assert.equal(u.formatReadRate(33.6), "34%");
	assert.equal(u.formatReadRate(140), "100%");
	assert.equal(u.formatReadRate(-3), "0%");
	assert.equal(u.formatReadRate(Number.NaN), "0%");
});

test("still sending shows only after an unsubscribe", () => {
	assert.equal(u.getRowView(row({ stillSending: true }), "full_access").stillSending, false);
	const sent = u.getRowView(row({ stillSending: true, unsubscribedAt: "2026-11-01T00:00:00.000Z" }), "full_access");
	assert.equal(sent.stillSending, true);
	assert.equal(sent.unsubscribedOn, "2026-11-01T00:00:00.000Z");
	const quiet = u.getRowView(row({ unsubscribedAt: "2026-11-01T00:00:00.000Z" }), "full_access");
	assert.equal(quiet.stillSending, false);
	assert.equal(quiet.unsubscribedOn, "2026-11-01T00:00:00.000Z");
});

test("only full access gets actions and the category control", () => {
	for (const permission of ["read_only", "send_as", "send_on_behalf", undefined]) {
		const view = u.getRowView(row(), permission);
		assert.deepEqual(view.actions, [], String(permission));
		assert.equal(view.canChange, false);
	}
	const full = u.getRowView(row(), "full_access");
	assert.equal(full.canChange, true);
	assert.deepEqual(full.actions, ["unsubscribe", "unsubscribeTrash", "block", "trash"]);
});

test("unsubscribe actions need an unsubscribe route and are not offered twice", () => {
	assert.deepEqual(u.getRowView(row({ canUnsubscribe: false }), "full_access").actions, ["block", "trash"]);
	assert.deepEqual(u.getRowView(row({ latestMessageId: null }), "full_access").actions, ["block", "trash"]);
	assert.deepEqual(u.getRowView(row({ unsubscribedAt: "2026-11-01T00:00:00.000Z" }), "full_access").actions, ["block", "trash"]);
	assert.deepEqual(
		u.getRowView(row({ unsubscribedAt: "2026-11-01T00:00:00.000Z", stillSending: true }), "full_access").actions,
		["unsubscribe", "unsubscribeTrash", "block", "trash"],
	);
});

test("category value maps between the select and the API", () => {
	assert.equal(u.getRowView(row(), "full_access").category, "auto");
	assert.equal(u.getRowView(row({ categoryOverride: "inbox" }), "full_access").category, "inbox");
	assert.equal(u.categoryToApi("auto"), null);
	assert.equal(u.categoryToApi("promotions"), "promotions");
	assert.equal(u.categoryToApi("inbox"), "inbox");
});

test("category result reports changed and the bounded remainder, never all", () => {
	assert.deepEqual(u.categoryResultCopy("auto", { changed: 0, remainingOlder: 0 }), { key: "subscriptions.categoryCleared" });
	assert.equal(u.categoryResultCopy("inbox", { changed: 4, remainingOlder: 7 }).key, "promotions.always.resultOlder");
	assert.deepEqual(u.categoryResultCopy("inbox", { changed: 4, remainingOlder: 7 }).vars, { changed: 4, remaining: 7 });
	assert.equal(u.categoryResultCopy("promotions", { changed: 4, remainingOlder: 0 }).key, "promotions.always.result");
});

test("trash confirm states what moves now and what stays", () => {
	assert.equal(u.trashConfirmCopy("trash", { count: 0, willChange: 0, olderLeft: 0 }), null);
	const small = u.trashConfirmCopy("trash", { count: 12, willChange: 12, olderLeft: 0 });
	assert.deepEqual(small, [{ key: "subscriptions.trashConfirm", vars: { count: 12 } }]);
	const capped = u.trashConfirmCopy("trash", { count: 620, willChange: 500, olderLeft: 30 });
	assert.deepEqual(capped, [
		{ key: "subscriptions.trashConfirm", vars: { count: 500 } },
		{ key: "subscriptions.leftBehind", vars: { count: 150 } },
	]);
	assert.equal(u.trashConfirmCopy("unsubscribeTrash", { count: 3, willChange: 3, olderLeft: 0 })[0].key, "subscriptions.unsubscribeTrashConfirm");
});

test("trash result reports the real counts", () => {
	assert.deepEqual(u.trashResultCopy({ changed: 0, remaining: 0 }), [{ key: "subscriptions.trashNothing" }]);
	assert.deepEqual(u.trashResultCopy({ changed: 500, remaining: 0 }), [{ key: "subscriptions.trashDone", vars: { count: 500 } }]);
	assert.deepEqual(u.trashResultCopy({ changed: 500, remaining: 40 }), [
		{ key: "subscriptions.trashDone", vars: { count: 500 } },
		{ key: "subscriptions.trashRemaining", vars: { remaining: 40 } },
	]);
	assert.deepEqual(u.trashResultCopy({ changed: 0, remaining: 9 }), [
		{ key: "subscriptions.trashNothing" },
		{ key: "subscriptions.trashRemaining", vars: { remaining: 9 } },
	]);
});

test("an emptied page steps back, a populated or first page stays", () => {
	assert.equal(u.pageBackOffset({ offset: 100, pageSize: 50, returned: 0, total: 101 }), 50);
	assert.equal(u.pageBackOffset({ offset: 100, pageSize: 50, returned: 0, total: 100 }), 50);
	assert.equal(u.pageBackOffset({ offset: 100, pageSize: 50, returned: 0, total: 20 }), 0);
	assert.equal(u.pageBackOffset({ offset: 50, pageSize: 50, returned: 0, total: 0 }), 0);
	assert.equal(u.pageBackOffset({ offset: 50, pageSize: 50, returned: 3, total: 53 }), 50);
	assert.equal(u.pageBackOffset({ offset: 0, pageSize: 50, returned: 0, total: 0 }), 0);
});

test("pager range and neighbours", () => {
	assert.deepEqual(u.getPager({ offset: 0, count: 50, total: 120, pageSize: 50 }), { start: 1, end: 50, total: 120, prevOffset: null, nextOffset: 50 });
	assert.deepEqual(u.getPager({ offset: 100, count: 20, total: 120, pageSize: 50 }), { start: 101, end: 120, total: 120, prevOffset: 50, nextOffset: null });
	assert.deepEqual(u.getPager({ offset: 0, count: 0, total: 0, pageSize: 50 }), { start: 0, end: 0, total: 0, prevOffset: null, nextOffset: null });
});

test("mailbox choices keep only mailboxes with Promotions on", () => {
	const mailboxes = [{ id: "a" }, { id: "b" }, { id: "c" }];
	const modes = { a: "off", b: "show", c: "separate" };
	assert.deepEqual(u.mailboxesWithPromotions(mailboxes, modes).map((m) => m.id), ["b", "c"]);
	assert.deepEqual(u.mailboxesWithPromotions(mailboxes, undefined), []);
	assert.equal(u.pickMailboxId(["b", "c"], "c", "b"), "c");
	assert.equal(u.pickMailboxId(["b", "c"], "zz", "c"), "c");
	assert.equal(u.pickMailboxId(["b", "c"], null, "a"), "b");
	assert.equal(u.pickMailboxId([], "b", "b"), null);
});

test("relative last-received uses whole days", () => {
	const now = new Date("2026-11-20T12:00:00.000Z");
	assert.equal(u.daysSince("2026-11-20T01:00:00.000Z", now), 0);
	assert.equal(u.daysSince("2026-11-18T10:00:00.000Z", now), 2);
	assert.equal(u.daysSince("2026-11-21T10:00:00.000Z", now), 0);
});

// i18n: every Subscriptions string exists in every catalog, with the plural categories the locale uses.
import { readFileSync, readdirSync } from "node:fs";

const en = JSON.parse(readFileSync(join(root, "src/lib/i18n/en.json"), "utf8"));
const catalogs = Object.fromEntries(readdirSync(join(root, "public/locales")).map((file) => [file.replace(".json", ""), JSON.parse(readFileSync(join(root, "public/locales", file), "utf8"))]));
const PLURAL_BASES = ["subscriptions.messages", "subscriptions.trashConfirm", "subscriptions.unsubscribeTrashConfirm", "subscriptions.leftBehind", "subscriptions.trashDone"];
const subscriptionKeys = Object.keys(en).filter((key) => key.startsWith("subscriptions.") || key === "navigation.subscriptions");

test("every catalog has every Subscriptions key and its plural categories", () => {
	const plain = subscriptionKeys.filter((key) => !PLURAL_BASES.some((base) => key.startsWith(`${base}.`)));
	for (const [locale, messages] of Object.entries(catalogs)) {
		for (const key of plain) assert.ok(typeof messages[key] === "string" && messages[key].trim(), `${locale} is missing ${key}`);
		const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
		for (const base of PLURAL_BASES) {
			for (const category of categories) assert.ok(typeof messages[`${base}.${category}`] === "string", `${locale} is missing ${base}.${category}`);
		}
	}
});

test("placeholders survive translation", () => {
	for (const [locale, messages] of Object.entries(catalogs)) {
		for (const key of subscriptionKeys) {
			if (typeof messages[key] !== "string") continue;
			const base = PLURAL_BASES.find((candidate) => key.startsWith(`${candidate}.`));
			const source = en[key] ?? en[`${base}.other`];
			const wanted = new Set(source.match(/\{\w+\}/g) ?? []);
			const found = new Set(messages[key].match(/\{\w+\}/g) ?? []);
			// Arabic .one/.two and similar forms may drop the number, but never invent a placeholder.
			for (const placeholder of found) assert.ok(wanted.has(placeholder), `${locale} ${key} has stray ${placeholder}`);
			if (!/\.(zero|one|two)$/.test(key)) for (const placeholder of wanted) assert.ok(found.has(placeholder), `${locale} ${key} lost ${placeholder}`);
		}
	}
});

test("English copy says Trash and never rejected, bounced or blocked", () => {
	for (const key of subscriptionKeys.filter((candidate) => candidate.includes("block") || candidate.includes("Trash") || candidate.includes("trash"))) {
		assert.doesNotMatch(en[key], /reject|bounce|refus|undeliver/i, key);
	}
	assert.match(en["subscriptions.blockConfirm"], /Trash/);
	assert.match(en["subscriptions.trashConfirm.other"], /Trash/);
});
