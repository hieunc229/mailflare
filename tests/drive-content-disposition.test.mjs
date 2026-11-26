import assert from "node:assert/strict";
import test from "node:test";
import { driveContentDisposition, normalizeDriveName } from "../src/lib/drive/utils.ts";

const encodedName = (header) => decodeURIComponent(header.match(/filename\*=UTF-8''([^;]*)$/)[1]);

test("a long name is not cut inside a surrogate pair", () => {
	assert.equal(normalizeDriveName(`${"a".repeat(254)}📄.pdf`), "a".repeat(254));
	assert.equal(normalizeDriveName(`${"a".repeat(253)}📄.pdf`), `${"a".repeat(253)}📄`);
});

test("a stored name that ends in half a surrogate pair still gets a header", () => {
	const header = driveContentDisposition(`${"a".repeat(254)}\ud83d`, false);
	assert.doesNotThrow(() => new Headers({ "Content-Disposition": header }));
	assert.equal(encodedName(header), `${"a".repeat(254)}�`);
});

test("the RFC 5987 value escapes ' ( ) * and the fallback drops %", () => {
	const header = driveContentDisposition("it's (final)*100%.txt", true);
	assert.equal(header, `inline; filename="it's (final)*100_.txt"; filename*=UTF-8''it%27s%20%28final%29%2A100%25.txt`);
	assert.equal(encodedName(header), "it's (final)*100%.txt");
});
