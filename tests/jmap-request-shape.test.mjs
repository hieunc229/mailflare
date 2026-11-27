import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * RFC 8620 §3.3: a method invocation is [name, args, id] with args an Object,
 * and §3.7: a `#` result reference is { resultOf, name, path }, all strings.
 * Shapes that break those rules are client errors — `notRequest` for the
 * request (400) and `invalidResultReference` for the call — never `serverFail`
 * plus a console.error, which blames the server for a bad request.
 *
 * `processRequest` runs against the same proxy `db` the batch-limit test uses:
 * `Core/echo` never queries, and the trailing sessionState read just sees `[]`.
 */
const outDir = mkdtempSync(join(tmpdir(), "mailflare-jmap-shape-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `export { processRequest, validateRequest } from "./src/lib/jmap/processor.ts";`,
		resolveDir: root,
		sourcefile: "jmap-shape-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { processRequest, validateRequest } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

const chain = new Proxy(function () {}, {
	apply: () => chain,
	get: (_, key) => {
		if (key === "then") return (onOk, onErr) => Promise.resolve([]).then(onOk, onErr);
		if (key === "catch") return (onErr) => Promise.resolve([]).catch(onErr);
		if (key === Symbol.toPrimitive) return () => "";
		return chain;
	},
});

const ctx = () => ({
	env: {},
	db: new Proxy({}, { get: () => chain }),
	auth: { userId: "admin", email: "owner@one.test", scopes: ["jmap"], mailboxIds: null, user: { id: "admin", email: "owner@one.test", role: "admin" } },
	accountId: "admin",
	origin: "http://test",
	createdIds: {},
});

const refCall = (ref, callId = "c2") => ["Core/echo", { "#ids": ref }, callId];
const ECHO = ["Core/echo", { a: 1 }, "c1"];

async function errorResponse(methodCalls) {
	const response = await processRequest(ctx(), { using: USING, methodCalls });
	const [name, result] = response.methodResponses.at(-1);
	assert.equal(name, "error", `expected an error response, got ${JSON.stringify(response.methodResponses)}`);
	return result;
}

test("a # result reference with a non-string path is invalidResultReference", async () => {
	for (const path of [5, null, ["/a"], { "/": "a" }]) {
		const error = await errorResponse([ECHO, refCall({ resultOf: "c1", name: "Core/echo", path })]);
		assert.equal(error.type, "invalidResultReference", `path=${JSON.stringify(path)}`);
	}
});

test("a # result reference with non-string resultOf or name is invalidResultReference", async () => {
	for (const ref of [
		{ resultOf: 5, name: "Core/echo", path: "/a" },
		{ resultOf: "c1", name: 5, path: "/a" },
		{ resultOf: true, name: "Core/echo", path: "/a" },
	]) {
		const error = await errorResponse([ECHO, refCall(ref)]);
		assert.equal(error.type, "invalidResultReference", `ref=${JSON.stringify(ref)}`);
	}
});

test("a # value that is not a reference object is invalidResultReference", async () => {
	for (const ref of ["c1", 5, null, ["/a"], true]) {
		const error = await errorResponse([ECHO, refCall(ref)]);
		assert.equal(error.type, "invalidResultReference", `ref=${JSON.stringify(ref)}`);
	}
});

test("a # reference to a missing response is still invalidResultReference", async () => {
	const error = await errorResponse([ECHO, refCall({ resultOf: "nope", name: "Core/echo", path: "/a" })]);
	assert.equal(error.type, "invalidResultReference");
});

test("non-object call args are rejected as notRequest", () => {
	for (const args of ["x", 5, true, [1], null]) {
		assert.throws(
			() => validateRequest({ using: USING, methodCalls: [["Core/echo", args, "c"]] }),
			{ type: "notRequest" },
			`args=${JSON.stringify(args)}`,
		);
	}
});

test("non-object createdIds is rejected as notRequest", () => {
	for (const createdIds of ["x", 5, ["a"]]) {
		assert.throws(
			() => validateRequest({ using: USING, methodCalls: [["Core/echo", {}, "c"]], createdIds }),
			{ type: "notRequest" },
			`createdIds=${JSON.stringify(createdIds)}`,
		);
	}
	assert.doesNotThrow(() => validateRequest({ using: USING, methodCalls: [["Core/echo", {}, "c"]], createdIds: null }));
	assert.doesNotThrow(() => validateRequest({ using: USING, methodCalls: [["Core/echo", {}, "c"]], createdIds: { k1: "srv1" } }));
});

test("a well-formed # result reference still resolves", async () => {
	const response = await processRequest(ctx(), {
		using: USING,
		methodCalls: [
			["Core/echo", { a: 1, list: [{ b: 2 }] }, "c1"],
			["Core/echo", { "#x": { resultOf: "c1", name: "Core/echo", path: "/a" }, "#y": { resultOf: "c1", name: "Core/echo", path: "/list/0/b" } }, "c2"],
		],
	});
	assert.deepEqual(response.methodResponses[1], ["Core/echo", { x: 1, y: 2 }, "c2"]);
});

test("calls with {} args and absent args still work", async () => {
	const response = await processRequest(ctx(), {
		using: USING,
		methodCalls: [
			["Core/echo", {}, "c0"],
			["Core/echo", undefined, "c1"],
		],
	});
	assert.deepEqual(response.methodResponses[0], ["Core/echo", {}, "c0"]);
	assert.deepEqual(response.methodResponses[1], ["Core/echo", {}, "c1"]);
});

test("well-formed calls still pass validateRequest", () => {
	const request = validateRequest({
		using: USING,
		methodCalls: [
			["Core/echo", { echo: true }, "c0"],
			["Email/get", { ids: ["m1"], "#blobId": { resultOf: "c0", name: "Core/echo", path: "/blobId" } }, "c1"],
		],
		createdIds: { draft1: "m9" },
	});
	assert.equal(request.methodCalls.length, 2);
});
