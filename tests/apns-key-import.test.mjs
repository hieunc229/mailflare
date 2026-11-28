import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { importApnsKey } from "../src/lib/push/native-crypto.ts";

const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });

test("the .p8 imports as pasted, with CRLFs, quotes or literal \\n", async () => {
	const key = await importApnsKey(pem);
	assert.equal(key.type, "private");
	assert.equal(key.algorithm.name, "ECDSA");
	await importApnsKey(pem.replace(/\n/g, "\r\n"));
	await importApnsKey(`"${pem.replace(/\n/g, "\\n")}"`);
	await importApnsKey(pem.trim().replace(/\n/g, "\\n"));
});

test("garbage is rejected", async () => {
	await assert.rejects(importApnsKey("not a key"));
});
