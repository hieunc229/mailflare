import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-route-utils-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({ entryPoints: { utils: join(root, "src/lib/deliverability/route-utils.ts") }, outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", plugins: [{ name: "next-server-stub", setup(builder) { builder.onResolve({ filter: /^next\/server$/ }, (args) => ({ path: args.path, namespace: "stub" })); builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const NextResponse = { json: (body, init) => Response.json(body, init) };", loader: "js" })); } }], format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent" });
const { migrationRequired } = await import(pathToFileURL(join(outDir, "utils.mjs")).href);

test("a missing table or column answers 409 MIGRATION_REQUIRED; any other error is rethrown", async () => {
	for (const message of ["no such table: domain_deliverability", "table deliverability_reports has no column named kind", 'column "mta_sts_mode" does not exist']) {
		const response = migrationRequired(new Error("Failed query", { cause: new Error(message) }));
		assert.equal(response.status, 409);
		assert.equal((await response.json()).code, "MIGRATION_REQUIRED");
	}
	assert.throws(() => migrationRequired(new Error("disk I/O error")), /disk I\/O/);
});
