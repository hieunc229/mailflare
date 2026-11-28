import assert from "node:assert/strict";
import test from "node:test";

import { extractUnsubscribeLinkFromBody } from "../src/lib/email/unsubscribe.ts";
import { analyzeUrls } from "../src/lib/spam/analyzers/urls.ts";
import { assertLinear } from "./helpers/scaling.mjs";

const prepared = { urlDomains: [] };

test("many unclosed anchors do not make the spam link check quadratic", () => {
	assertLinear((n) => "<a ".repeat(n), (html) => analyzeUrls({ html }, prepared), 20_000, "bare anchors");
	assertLinear((n) => '<a href="http://x.example/'.repeat(n), (html) => analyzeUrls({ html }, prepared), 2_000, "anchors with href");
});

test("many unclosed anchors do not make the unsubscribe scan quadratic", () => {
	assertLinear((n) => '<a href="https://x.example/">'.repeat(n), (html) => extractUnsubscribeLinkFromBody(html, null), 12_000, "unsubscribe anchors");
});

test("mismatched displayed link is still flagged and unsubscribe anchor still found", () => {
	const mismatch = '<a href="https://evil.example/x">https://bank.example/login</a>';
	assert.equal(analyzeUrls({ html: mismatch }, prepared).some((s) => s.id === "displayed_link_mismatch"), true);
	const footer = `${"<p>hi</p>".repeat(5_000)}<a class="u" href="https://x.example/unsub?id=1">Unsubscribe</a>`;
	assert.equal(extractUnsubscribeLinkFromBody(footer, null), "https://x.example/unsub?id=1");
});
