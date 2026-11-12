import assert from "node:assert/strict";
import test from "node:test";

import { extractUnsubscribeUrlFromRaw, extractUnsubscribeLinkFromBody, dkimCoveredHeaders, parseMailtoUnsubscribe } from "../src/lib/email/unsubscribe.ts";

const enc = (s) => new TextEncoder().encode(s).buffer;

test("https List-Unsubscribe beats mailto, both angle-bracketed", () => {
	const raw = enc(`From: list@x.com\r\nList-Unsubscribe: <mailto:un@x.com>, <https://x.com/unsub/1>\r\n\r\nbody`);
	const result = extractUnsubscribeUrlFromRaw(raw);
	assert.equal(result.url, "https://x.com/unsub/1");
	assert.equal(result.oneClick, false);
});

test("folded header lines keep the value whole", () => {
	const raw = enc(`From: a@x.com\nList-Unsubscribe:\n <https://x.com/very?long=yes>\n\r\nbody`);
	assert.equal(extractUnsubscribeUrlFromRaw(raw).url, "https://x.com/very?long=yes");
});

test("one-click marker is detected case-insensitively", () => {
	const raw = enc(`List-Unsubscribe: <https://x.com/u>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nb`);
	assert.equal(extractUnsubscribeUrlFromRaw(raw).oneClick, true);
});

test("javascript: and data: candidates are rejected", () => {
	const raw = enc(`List-Unsubscribe: <javascript:alert(1)>\r\n\r\nb`);
	assert.equal(extractUnsubscribeUrlFromRaw(raw), null);
});

test("dkimCoveredHeaders parses the h= list across signatures", () => {
	const headers = new Map([["dkim-signature", [
		"v=1; a=rsa-sha256; d=x.com; s=s1; h=from:to:subject:list-unsubscribe; b=abc",
		"v=1; a=ed25519-sha256; d=y.com; s=s2; h=from:list-unsubscribe-post; b=def",
	]]]);
	const covered = dkimCoveredHeaders(headers);
	assert.ok(covered.has("list-unsubscribe"));
	assert.ok(covered.has("list-unsubscribe-post"));
	assert.ok(!covered.has("subject-x"));
});

test("one-click requires signed List-Unsubscribe coverage", () => {
	const signed = enc(`DKIM-Signature: v=1; d=x.com; h=from:list-unsubscribe; b=q\r\nList-Unsubscribe: <https://x.com/u>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nb`);
	const unsigned = enc(`DKIM-Signature: v=1; d=x.com; h=from:subject; b=q\r\nList-Unsubscribe: <https://x.com/u>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nb`);
	assert.equal(extractUnsubscribeUrlFromRaw(signed).dkimCoversUnsubscribe, true);
	assert.equal(extractUnsubscribeUrlFromRaw(unsigned).dkimCoversUnsubscribe, false);
});

test("body fallback finds the anchor that says unsubscribe", () => {
	const html = `<p>hello</p><a href="https://x.com/u?a=1&amp;b=2">Unsubscribe</a>`;
	assert.equal(extractUnsubscribeLinkFromBody(html, null), "https://x.com/u?a=1&b=2");
});

test("body fallback ignores non-http hrefs", () => {
	const html = `<a href="javascript:void(0)">Unsubscribe</a>`;
	assert.equal(extractUnsubscribeLinkFromBody(html, null), null);
});

test("text-body fallback picks the unsubscribe-looking URL only", () => {
	const text = "Visit https://x.com/home or https://x.com/unsubscribe-now.";
	assert.equal(extractUnsubscribeLinkFromBody(null, text), "https://x.com/unsubscribe-now");
});

test("mailto target is sanitized to a single recipient without header injection", () => {
	const t = parseMailtoUnsubscribe("mailto:un@x.com?subject=Stop%0D%0ABCC:%20evil%40x.com&body=please%20remove%20me");
	assert.equal(t.to, "un@x.com");
	assert.match(t.subject, /^Stop BCC/);
	assert.equal(t.text, "please remove me");
});

test("mailto with multiple recipients keeps only the first", () => {
	const t = parseMailtoUnsubscribe("mailto:a%40x.com%2Cevil%40y.com");
	assert.equal(t.to, "a@x.com");
});

test("non-mailto and empty targets return null", () => {
	assert.equal(parseMailtoUnsubscribe("https://x.com/u"), null);
	assert.equal(parseMailtoUnsubscribe("mailto:"), null);
});
