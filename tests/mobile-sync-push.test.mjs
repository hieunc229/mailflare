import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-mobile-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const changes = await bundle("src/lib/jmap/changes-utils.ts", "changes-utils.mjs");
const push = await bundle("src/lib/push/native-crypto.ts", "native-crypto.mjs");

test("JMAP states round-trip and reject other formats", () => {
	assert.deepEqual(changes.parseState(changes.formatState(42, "abcd")), { seq: 42, fingerprint: "abcd" });
	assert.equal(changes.parseState('[["mbx","full_access"]]'), null);
	assert.equal(changes.parseState("c1:-1:abcd"), null);
	assert.equal(changes.parseState(null), null);
});

test("change rows coalesce into JMAP created/updated/destroyed", () => {
	const result = changes.coalesceChanges([
		{ id: "a", change: "created" },
		{ id: "a", change: "updated" },
		{ id: "b", change: "updated" },
		{ id: "c", change: "created" },
		{ id: "c", change: "destroyed" },
		{ id: "d", change: "updated" },
		{ id: "d", change: "destroyed" },
		{ id: "e", change: "destroyed" },
		{ id: "e", change: "created" },
	]);
	assert.deepEqual(result.created, ["a"]);
	assert.deepEqual(result.updated.sort(), ["b", "e"]);
	assert.deepEqual(result.destroyed, ["d"]);
});

test("push previews decrypt with the device key (ECDH + HKDF + AES-GCM)", async () => {
	const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const publicKey = push.toBase64(new Uint8Array(await crypto.subtle.exportKey("raw", device.publicKey)));
	assert.equal(push.isValidDevicePublicKey(publicKey), true);
	assert.equal(push.isValidDevicePublicKey("AAAA"), false);

	const message = JSON.stringify({ from: "ann@x.com", subject: "Hello" });
	const enc = await push.encryptPreview(publicKey, new TextEncoder().encode(message));

	const ephemeral = await crypto.subtle.importKey("raw", push.fromBase64(enc.epk), { name: "ECDH", namedCurve: "P-256" }, false, []);
	const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeral }, device.privateKey, 256);
	const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
	const key = await crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: push.fromBase64(enc.salt), info: new TextEncoder().encode(push.PUSH_HKDF_INFO) },
		hkdf,
		{ name: "AES-GCM", length: 256 },
		false,
		["decrypt"],
	);
	const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: push.fromBase64(enc.iv) }, key, push.fromBase64(enc.ct));
	assert.equal(new TextDecoder().decode(plain), message);
});

test("APNs provider tokens are verifiable ES256 JWTs", async () => {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	const pem = `-----BEGIN PRIVATE KEY-----\n${push.toBase64(pkcs8)}\n-----END PRIVATE KEY-----`;
	const jwt = await push.signApnsJwt(await push.importApnsKey(pem), "KEY123", "TEAM456", 1700000000);
	const [header, claims, signature] = jwt.split(".");
	assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", kid: "KEY123" });
	assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), { iss: "TEAM456", iat: 1700000000 });
	const valid = await crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		pair.publicKey,
		Buffer.from(signature, "base64url"),
		new TextEncoder().encode(`${header}.${claims}`),
	);
	assert.equal(valid, true);
});

test("sendNativePush does not query devices when native push is not configured", async () => {
	const mocks = {
		"@/db": `export const getDb = () => ({ select: () => { globalThis.__nativePushSelects += 1; throw new Error("device query"); } });`,
		"@/db/schema": "export const pushDevices = {};",
	};
	const file = join(outDir, "native-send.mjs");
	await build({
		entryPoints: [join(root, "src/lib/push/native.ts")],
		outfile: file,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
		plugins: [{
			name: "native-mocks",
			setup(builder) {
				builder.onResolve({ filter: /^@\/db(\/schema)?$/ }, ({ path }) => ({ path, namespace: "mock" }));
				builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: mocks[path], loader: "js" }));
			},
		}],
	});
	globalThis.__nativePushSelects = 0;
	const native = await import(pathToFileURL(file).href);
	await native.sendNativePush({}, ["u1"], { messageId: "m1", mailboxId: "mb" });
	assert.equal(globalThis.__nativePushSelects, 0);
});
