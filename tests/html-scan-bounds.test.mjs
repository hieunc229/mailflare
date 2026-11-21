import assert from "node:assert/strict";
import test from "node:test";

import { extractUnsubscribeLinkFromBody } from "../src/lib/email/unsubscribe.ts";
import { analyzeUrls } from "../src/lib/spam/analyzers/urls.ts";

const prepared = { urlDomains: [] };
const time = (fn) => {
	const started = Date.now();
	fn();
	return Date.now() - started;
};

test("many unclosed anchors do not make the spam link check quadratic", () => {
	const html = "<a ".repeat(80_000);
	assert.ok(time(() => analyzeUrls({ html }, prepared)) < 1500);
	const withHref = '<a href="http://x.example/'.repeat(8_000);
	assert.ok(time(() => analyzeUrls({ html: withHref }, prepared)) < 1500);
});

test("many unclosed anchors do not make the unsubscribe scan quadratic", () => {
	const html = '<a href="https://x.example/">'.repeat(30_000);
	assert.ok(time(() => extractUnsubscribeLinkFromBody(html, null)) < 1500);
});

test("mismatched displayed link is still flagged and unsubscribe anchor still found", () => {
	const mismatch = '<a href="https://evil.example/x">https://bank.example/login</a>';
	assert.equal(analyzeUrls({ html: mismatch }, prepared).some((s) => s.id === "displayed_link_mismatch"), true);
	const footer = `${"<p>hi</p>".repeat(5_000)}<a class="u" href="https://x.example/unsub?id=1">Unsubscribe</a>`;
	assert.equal(extractUnsubscribeLinkFromBody(footer, null), "https://x.example/unsub?id=1");
});
