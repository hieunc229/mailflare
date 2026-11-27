import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-spam-parallel-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const mocks = {
	"drizzle-orm": "export const eq=(c,v)=>({eq:[c,v]});export const and=(...a)=>({and:a});export const inArray=(c,v)=>({inArray:[c,v]});export const count=()=>({count:true});",
	"@/db/schema": "export const spamFeedback={mailboxId:'fb.m',classification:'fb.c'};export const spamTokenStats={mailboxId:'ts.m',token:'ts.t'};",
};
await build({
	stdin: { contents: "export { classifyTokens } from './src/lib/spam/classifier';", resolveDir: root, loader: "ts" },
	outfile: join(outDir, "classifier.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "mock-deps",
		setup(builder) {
			const names = Object.keys(mocks).map((name) => name.replace(/[/.-]/g, "\\$&")).join("|");
			builder.onResolve({ filter: new RegExp(`^(${names})$`) }, (args) => ({ path: args.path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
	logLevel: "silent",
});
const { classifyTokens } = await import(pathToFileURL(join(outDir, "classifier.mjs")).href);

// Fake db: feedback counts resolve to 25, token chunks resolve after a tick with one row per
// token (identical counts so every probability ties and only row order decides the result).
function fakeDb() {
	const stats = { inFlight: 0, maxInFlight: 0, tokenQueries: 0, chunkSizes: [] };
	const db = {
		select() {
			let table;
			let tokens;
			const chain = {
				from(t) { table = t; return chain; },
				where(condition) {
					if (condition.and[1]?.inArray) tokens = condition.and[1].inArray[1];
					return chain;
				},
				then(resolve, reject) {
					if (tokens === undefined) return Promise.resolve([{ value: 25 }]).then(resolve, reject);
					stats.tokenQueries += 1;
					stats.chunkSizes.push(tokens.length);
					stats.inFlight += 1;
					stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
					return new Promise((done) => setTimeout(done, 5)).then(() => {
						stats.inFlight -= 1;
						return tokens.map((token) => ({ token, spamCount: 9, hamCount: 1 }));
					}).then(resolve, reject);
				},
			};
			return chain;
		},
	};
	return { db, stats };
}

test("token chunks run in parallel", async () => {
	const { db, stats } = fakeDb();
	const tokens = Array.from({ length: 200 }, (_, i) => `t${i}`);
	await classifyTokens(db, "m1", tokens);
	assert.deepEqual(stats.chunkSizes, [90, 90, 20]);
	assert.equal(stats.maxInFlight, 3);
});

test("results keep chunk order, so tied tokens resolve exactly as the serial loop did", async () => {
	const { db } = fakeDb();
	const tokens = Array.from({ length: 200 }, (_, i) => `t${i}`);
	const result = await classifyTokens(db, "m1", tokens);
	const picked = result.strongestTokens.map((entry) => entry.token);
	assert.deepEqual(picked, tokens.slice(0, picked.length));
	assert.equal(result.trainedMessages, 50);
	assert.ok(result.probability > 0.5);
});

test("no tokens or untrained mailbox issue no token queries", async () => {
	const { db, stats } = fakeDb();
	const result = await classifyTokens(db, "m1", []);
	assert.equal(result.probability, 0.5);
	assert.equal(stats.tokenQueries, 0);
});
