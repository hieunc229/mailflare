import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-dns-query-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/dns-query.ts")],
	outfile: join(outDir, "dns-query.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});

const { queryDns } = await import(pathToFileURL(join(outDir, "dns-query.mjs")).href);

function answerServer(answers) {
	return async (input) => {
		const type = new URL(String(input)).searchParams.get("type");
		const list = answers[type] ?? [];
		return new Response(JSON.stringify({ Status: 0, Answer: list }), { status: 200 });
	};
}

test("a CNAME chain does not leak hostnames into an A lookup", async (t) => {
	// One chain record then the terminal A record the resolver chased.
	t.mock.method(globalThis, "fetch", answerServer({
		A: [
			{ name: "images.example.", type: 5, TTL: 300, data: "edge.example." },
			{ name: "edge.example.", type: 1, TTL: 60, data: "203.0.113.7" },
		],
		AAAA: [
			{ name: "images.example.", type: 5, TTL: 300, data: "edge.example." },
		],
	}));
	assert.deepEqual(await queryDns("images.example", "A"), ["203.0.113.7"]);
	assert.deepEqual(await queryDns("images.example", "AAAA"), []);
});

test("a AAAA lookup whose chain has no terminal AAAA resolves to no addresses", async (t) => {
	t.mock.method(globalThis, "fetch", answerServer({
		AAAA: [{ name: "images.example.", type: 5, TTL: 300, data: "edge.example." }],
	}));
	assert.deepEqual(await queryDns("images.example", "AAAA"), []);
});

test("a CNAME query still returns the chain hostname", async (t) => {
	t.mock.method(globalThis, "fetch", answerServer({
		CNAME: [{ name: "images.example.", type: 5, TTL: 300, data: "edge.example." }],
	}));
	assert.deepEqual(await queryDns("images.example", "CNAME"), ["edge.example."]);
});
