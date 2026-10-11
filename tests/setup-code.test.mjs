import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["src/lib/auth/setup-code-utils.ts"], bundle: true, write: false, platform: "neutral", format: "esm" });
const { deriveSetupCode, getSetupCode, normalizeSetupCode } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function expectedCode(secret) {
	const digest = createHmac("sha256", secret).update("mailflare:first-run-setup").digest().subarray(0, 10);
	const bits = [...digest].map((byte) => byte.toString(2).padStart(8, "0")).join("");
	const chars = bits.match(/.{5}/g).map((chunk) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[parseInt(chunk, 2)]).join("");
	return chars.match(/.{4}/g).join("-");
}

test("derived codes are 80-bit Crockford base32 in groups of four", async () => {
	for (const secret of ["cf-token-one", "cf-token-two", "x"]) {
		const code = await deriveSetupCode(secret);
		assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
		assert.equal(code, expectedCode(secret));
		assert.equal(await deriveSetupCode(secret), code);
	}
	assert.notEqual(await deriveSetupCode("cf-token-one"), await deriveSetupCode("cf-token-two"));
});

test("typed codes ignore case, spacing, dashes and look-alike letters", () => {
	assert.equal(normalizeSetupCode(" abcd-efgh jkmn-pqrs "), "ABCDEFGHJKMNPQRS");
	assert.equal(normalizeSetupCode("O1IL-o0il"), normalizeSetupCode("0111-0011"));
});

test("SETUP_TOKEN wins, then the runtime secret, then the Cloudflare credentials", async () => {
	assert.deepEqual(await getSetupCode({ SETUP_TOKEN: " chosen ", SETUP_CODE_SECRET: "node", CF_TOKEN: "cf" }), { code: "chosen", derived: false });
	assert.deepEqual(await getSetupCode({ SETUP_CODE_SECRET: "node", CF_TOKEN: "cf" }), { code: expectedCode("node"), derived: true });
	assert.deepEqual(await getSetupCode({ CF_TOKEN: " cf " }), { code: expectedCode("cf"), derived: true });
	assert.deepEqual(await getSetupCode({ CF_API_KEY: "global" }), { code: expectedCode("global"), derived: true });
	assert.equal(await getSetupCode({ SETUP_TOKEN: "  ", CF_TOKEN: "" }), null);
});
