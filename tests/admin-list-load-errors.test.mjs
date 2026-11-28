import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(`src/app/(admin)/${name}/page.tsx`, "utf8");
const PAGES = [
	["activity", "activity.none"],
	["api-keys", "apiKeys.none"],
	["webhooks", "webhooks.none"],
	["domains", "domains.none"],
	["mailboxes", "mailboxes.none"],
];

test("domains and mailboxes list fetchers throw on a non-OK response", () => {
	for (const [name, key] of [["domains", 'queryKey: ["domains"]'], ["mailboxes", 'queryKey: ["mailboxes"]']]) {
		const source = read(name);
		const start = source.indexOf(key);
		assert.ok(start >= 0, `${name}: query found`);
		assert.ok(source.slice(start, source.indexOf("});", start)).includes("!res.ok"), `${name}: checks res.ok`);
	}
	const mailboxes = read("mailboxes");
	const options = mailboxes.indexOf('queryKey: ["domains", "options"]');
	assert.ok(mailboxes.slice(options, mailboxes.indexOf("});", options)).includes("!res.ok"));
});

test("admin lists render a retry state before their empty state", () => {
	for (const [name, noneKey] of PAGES) {
		const source = read(name);
		assert.ok(source.includes("isError"), `${name}: isError`);
		assert.ok(source.includes('role="alert"'), `${name}: alert`);
		assert.ok(source.includes("list.loadFailed") && source.includes("webhooks.retry"), `${name}: message and Retry`);
		assert.ok(source.indexOf("isError") < source.indexOf(`${noneKey}"`), `${name}: error branch precedes the empty text`);
	}
});
