import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-tenancy-routing-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const mocks = {
	"@/db/external": "export function openDatabaseFromExecutor() { return {}; }",
	"./executor": "export function tenantExecutor() { return {}; }",
	"@/lib/storage/b2-config": "export const getB2Config = () => null; export const describeB2Problem = () => null;",
	"@/lib/storage/b2-bucket": "export const openB2Bucket = () => null;",
	"./plans": "export const tenantLimitsFor = () => ({});",
	"./scope": "export const routeBucket = () => ({}); export const scopeBucket = () => ({}); export const scopeNamespace = () => ({}); export const scopeQueue = () => ({});",
};
await build({
	entryPoints: [join(root, "src/lib/tenancy/index.ts")],
	outfile: join(outDir, "index.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	logLevel: "silent",
	plugins: [{
		name: "tenancy-test-mocks",
		setup(build) {
			build.onResolve({ filter: /.*/ }, (args) => mocks[args.path] ? { path: args.path, namespace: "mock" } : undefined);
			build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
});
const { findTenantByHost } = await import(pathToFileURL(join(outDir, "index.mjs")).href);

const row = (id) => ({ id, status: "active", domain: `${id}.example`, name: id, admin_email: null, admin_password_hash: null, admin_name: null, contact_email: null, limits: null });

test("host reassignment is reflected immediately instead of routing to the previous tenant", async () => {
	let owner = "tenant-a";
	const env = { CONTROL: { prepare() { return { bind() { return { first: async () => row(owner) }; } }; } } };
	assert.equal((await findTenantByHost(env, "shared.example")).id, "tenant-a");
	owner = "tenant-b";
	assert.equal((await findTenantByHost(env, "shared.example")).id, "tenant-b");
});
