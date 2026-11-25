import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = "src/app/(admin)/deliverability";
const read = (file) => readFileSync(join(root, file), "utf8");
const en = JSON.parse(read("src/lib/i18n/en.json"));

test("the page loads domains and settings independently, with a retry and no raw error text", () => {
	const page = read(`${dir}/page.tsx`);
	assert.match(page, /Promise\.allSettled/);
	assert.doesNotMatch(page, /Promise\.all\(/);
	assert.doesNotMatch(page, /cause\.message/);
	assert.match(page, /t\("accounts\.domainsFailed"\)/);
	assert.match(page, /t\("general\.loadFailed"\)/);
	assert.match(page, /t\("webhooks\.retry"\)/);
	assert.ok(en["accounts.domainsFailed"] && en["general.loadFailed"] && en["webhooks.retry"]);
});

test("the DMARC chart does not collapse its bars on a phone", () => {
	const chart = read(`${dir}/DmarcChart.tsx`);
	assert.match(chart, /items-end gap-px border-b border-neutral-200 sm:gap-1/);
	assert.doesNotMatch(chart, /items-end gap-1 border-b/);
});

test("the suppression list keeps Remove reachable at 375px and ignores stale responses", () => {
	const list = read(`${dir}/SuppressionList.tsx`);
	assert.match(list, /sticky end-0/, "action column is sticky");
	assert.match(list, /flex-wrap/, "pager wraps");
	assert.match(list, /requestId|latest\.current/, "responses carry a request counter");
	assert.match(list, /requestId\.current === id/);
});

test("the TLS policies table has its own empty text", () => {
	const tls = read(`${dir}/TlsTab.tsx`);
	assert.match(tls, /t\("tls\.policies\.empty"\)/);
	assert.ok(en["tls.policies.empty"]);
});
