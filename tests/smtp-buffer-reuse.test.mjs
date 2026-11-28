import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("smtp data path converts the message once", async () => {
	const source = await readFile(new URL("../server/runtime/smtp.ts", import.meta.url), "utf8");
	assert.equal(source.split("toArrayBuffer(raw)").length - 1, 1);
});
