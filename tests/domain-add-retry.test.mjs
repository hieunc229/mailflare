import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-add-retry-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/app/(admin)/domains/api.ts")],
	outfile: join(outDir, "api.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});

const apiModule = await import(pathToFileURL(join(outDir, "api.mjs")).href);
const { confirmMxReplacement, ApiError } = apiModule;
const defaultCreateDomain = async (input) => {
	const res = await globalThis.fetch("/api/domains", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const json = await res.json();
	if (!res.ok) throw new (ApiError ?? Error)(json.error ?? "Failed", json);
	return json;
};
const createDomain = apiModule.createDomain ?? defaultCreateDomain;
const isMxConflictError = apiModule.isMxConflictError ?? (() => false);

function createMockFetch(responses) {
	const calls = [];
	let index = 0;
	const fetchMock = async (url, options = {}) => {
		const callIndex = index++;
		const spec = responses[callIndex] ?? responses[responses.length - 1];
		const parsedBody = options.body ? JSON.parse(options.body) : undefined;
		calls.push({ url: String(url), options, body: parsedBody });
		return {
			status: spec.status ?? 200,
			ok: spec.ok ?? ((spec.status ?? 200) >= 200 && (spec.status ?? 200) < 300),
			headers: new Headers(spec.headers ?? { "Content-Type": "application/json" }),
			async json() {
				return typeof spec.data === "function" ? spec.data(parsedBody) : (spec.data ?? {});
			},
			async text() {
				return JSON.stringify(typeof spec.data === "function" ? spec.data(parsedBody) : (spec.data ?? {}));
			},
		};
	};
	return { fetchMock, calls };
}

test("confirmMxReplacement returns true for 409 MX_RECORDS_CONFLICT when confirmed", () => {
	let prompt = null;
	globalThis.window = {
		confirm(message) {
			prompt = message;
			return true;
		},
	};
	const res = new Response(null, { status: 409 });
	const data = {
		code: "MX_RECORDS_CONFLICT",
		error: "Existing MX records currently deliver mail to another provider. Continue to delete them and replace them with Cloudflare Email Routing.",
	};
	const result = confirmMxReplacement(res, data);
	assert.equal(result, true);
	assert.equal(
		prompt,
		"Existing MX records currently deliver mail to another provider. Continue to delete them and replace them with Cloudflare Email Routing.\n\nReplace them? Mail will stop going to the current service.",
	);
});

test("on 409 MX_RECORDS_CONFLICT (no records), when user confirms, retries with replaceMxRecords: true and succeeds", async () => {
	const { fetchMock, calls } = createMockFetch([
		{
			status: 409,
			ok: false,
			data: {
				error: "Existing MX records currently deliver mail to another provider.",
				code: "MX_RECORDS_CONFLICT",
			},
		},
		{
			status: 200,
			ok: true,
			data: { domain: { id: "dom_123", hostname: "example.com" } },
		},
	]);
	globalThis.fetch = fetchMock;

	let confirmPrompt = null;
	globalThis.window = {
		confirm(message) {
			confirmPrompt = message;
			return true;
		},
	};

	const input = {
		hostname: "example.com",
		enableRouting: true,
		skipDns: false,
		sendingProvider: "cloudflare",
		receivingProvider: "cloudflare",
	};

	const result = await createDomain(input);
	assert.deepEqual(result, { domain: { id: "dom_123", hostname: "example.com" } });
	assert.equal(calls.length, 2, "must make initial request and one retry request");
	assert.equal(calls[0].url, "/api/domains");
	assert.equal(calls[0].body.replaceMxRecords, undefined);
	assert.equal(calls[0].body.hostname, "example.com");
	assert.equal(calls[0].body.enableRouting, true);
	assert.equal(calls[0].body.skipDns, false);
	assert.equal(calls[0].body.sendingProvider, "cloudflare");
	assert.equal(calls[0].body.receivingProvider, "cloudflare");
	assert.equal(calls[1].url, "/api/domains");
	assert.equal(calls[1].body.replaceMxRecords, true);
	assert.equal(calls[1].body.hostname, "example.com");
	assert.equal(calls[1].body.enableRouting, true);
	assert.equal(calls[1].body.skipDns, false);
	assert.equal(calls[1].body.sendingProvider, "cloudflare");
	assert.equal(calls[1].body.receivingProvider, "cloudflare");
	assert.equal(
		confirmPrompt,
		"Existing MX records currently deliver mail to another provider.\n\nReplace them? Mail will stop going to the current service.",
	);
});

test("on 409 MX_RECORDS_CONFLICT, when user declines, does not retry and throws ApiError", async () => {
	const { fetchMock, calls } = createMockFetch([
		{
			status: 409,
			ok: false,
			data: {
				error: "Existing MX records currently deliver mail to another provider.",
				code: "MX_RECORDS_CONFLICT",
			},
		},
	]);
	globalThis.fetch = fetchMock;

	let confirmed = false;
	globalThis.window = {
		confirm() {
			confirmed = true;
			return false;
		},
	};

	const input = {
		hostname: "example.com",
		enableRouting: true,
		skipDns: false,
		sendingProvider: "cloudflare",
		receivingProvider: "cloudflare",
	};

	await assert.rejects(
		async () => createDomain(input),
		(err) => {
			assert.ok(err instanceof ApiError);
			assert.equal(err.message, "Existing MX records currently deliver mail to another provider.");
			assert.equal(isMxConflictError(err), true);
			return true;
		},
	);

	assert.equal(confirmed, true, "user must be prompted to confirm");
	assert.equal(calls.length, 1, "must not retry when user declines replacement");
});

test("supports 409 MX_CONFLICT with records list for per-domain flows", async () => {
	const { fetchMock, calls } = createMockFetch([
		{
			status: 409,
			ok: false,
			data: {
				error: "This domain has MX records for another mail service.",
				code: "MX_CONFLICT",
				records: [
					{ priority: 10, content: "mail.legacy.test" },
					{ priority: 20, content: "mail2.legacy.test" },
				],
			},
		},
		{
			status: 200,
			ok: true,
			data: { domain: { id: "dom_456", hostname: "custom.test" } },
		},
	]);
	globalThis.fetch = fetchMock;

	let confirmPrompt = null;
	globalThis.window = {
		confirm(message) {
			confirmPrompt = message;
			return true;
		},
	};

	const result = await createDomain({ hostname: "custom.test" });
	assert.deepEqual(result, { domain: { id: "dom_456", hostname: "custom.test" } });
	assert.equal(calls.length, 2, "must retry with replace flag");
	assert.equal(calls[1].body.replaceMxRecords, true);
	assert.ok(confirmPrompt && confirmPrompt.includes("  10 mail.legacy.test\n  20 mail2.legacy.test"));
});

test("on non-MX 409 or other errors, does not prompt and throws without retry", async () => {
	const { fetchMock, calls } = createMockFetch([
		{
			status: 409,
			ok: false,
			data: {
				error: "Domain is already registered",
				code: "DOMAIN_EXISTS",
			},
		},
	]);
	globalThis.fetch = fetchMock;

	globalThis.window = {
		confirm() {
			throw new Error("confirm must not be called for non-MX conflicts");
		},
	};

	await assert.rejects(
		async () => createDomain({ hostname: "example.com" }),
		(err) => {
			assert.ok(err instanceof ApiError);
			assert.equal(isMxConflictError(err), false);
			return true;
		},
	);
	assert.equal(calls.length, 1, "must not retry non-MX conflict");

	// 500 error
	const serverErrorMock = createMockFetch([
		{
			status: 500,
			ok: false,
			data: { error: "Internal Server Error" },
		},
	]);
	globalThis.fetch = serverErrorMock.fetchMock;

	await assert.rejects(
		async () => createDomain({ hostname: "example.com" }),
		(err) => {
			assert.ok(err instanceof ApiError);
			assert.equal(isMxConflictError(err), false);
			return true;
		},
	);
	assert.equal(serverErrorMock.calls.length, 1, "must not retry on 500 error");
});

test("isMxConflictError helper correctly detects MX conflict errors for UI checklist suppression", () => {
	assert.equal(isMxConflictError(new ApiError("conflict", { code: "MX_CONFLICT" })), true);
	assert.equal(isMxConflictError(new ApiError("conflict", { code: "MX_RECORDS_CONFLICT" })), true);
	assert.equal(isMxConflictError(new ApiError("forbidden", { code: "FORBIDDEN" })), false);
	assert.equal(isMxConflictError(new ApiError("other", {})), false);
	assert.equal(isMxConflictError(new Error("standard error")), false);
	assert.equal(isMxConflictError(null), false);
	assert.equal(isMxConflictError(undefined), false);
});
