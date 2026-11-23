import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(project, "tests", ".tmp-malformed-license-"));
after(() => { rmSync(temporary, { recursive: true, force: true }); });

// A malformed JSON body is a client error, so it must be a 400. Node's JSON.parse
// echoes the input inside the SyntaxError message, and getLicenseErrorResponse
// tests that message against /no such table|license_settings/i, so a crafted body
// like `license_settings` used to be misclassified as a missing migration -> 503.
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/auth/cookies": "export async function requireUser(){return {id:'admin',role:'admin',isPrimaryAdmin:true}}",
	"@/lib/auth/admin": "export function assertPrimaryAdmin(){}",
	"@/lib/licenses/service": "export async function activateLicense(){return {status:'active'}} export async function validateLicense(){return {status:'active'}} export async function deactivateLicense(){return {status:'none'}} export async function getLicenseStatus(){return null}",
};

await build({
	stdin: {
		contents: `export * as activate from './src/app/api/licenses/activate/route';export * as validate from './src/app/api/licenses/validate/route';export * as deactivate from './src/app/api/licenses/deactivate/route';`,
		resolveDir: project,
		loader: "ts",
	},
	outfile: join(temporary, "routes.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(project, "src") },
	plugins: [{ name: "malformed-license-body-mocks", setup(builder) {
		builder.onResolve({ filter: /.*/ }, (args) => (
			args.path in mocks ? { path: args.path, namespace: "mock" } : undefined
		));
		builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
	} }],
	logLevel: "silent",
});
const { activate, validate, deactivate } = await import(pathToFileURL(join(temporary, "routes.mjs")).href);

const post = (path, body) => new Request(`https://mail.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });

test("POST /api/licenses/activate answers 400 for a malformed body containing license_settings", async () => {
	const response = await activate.POST(post("/api/licenses/activate", "license_settings"));
	assert.equal(response.status, 400);
	assert.equal((await response.json()).error, "Enter a valid license key");
});

test("POST /api/licenses/validate answers 400 for a malformed body containing license_settings", async () => {
	const response = await validate.POST(post("/api/licenses/validate", "no such table"));
	assert.equal(response.status, 400);
	assert.equal((await response.json()).error, "Enter a valid license key");
});

test("POST /api/licenses/activate answers 400 for plain malformed JSON", async () => {
	const response = await activate.POST(post("/api/licenses/activate", "{not valid json"));
	assert.equal(response.status, 400);
	assert.equal((await response.json()).error, "Enter a valid license key");
});

test("well-formed but schema-invalid bodies keep their existing 400", async () => {
	assert.equal((await activate.POST(post("/api/licenses/activate", "{}"))).status, 400);
	assert.equal((await validate.POST(post("/api/licenses/validate", '{"licenseKey":""}'))).status, 400);
});

test("well-formed valid bodies still reach the license service", async () => {
	assert.equal((await activate.POST(post("/api/licenses/activate", '{"licenseKey":"key-1","plan":"pro"}'))).status, 200);
	assert.equal((await validate.POST(post("/api/licenses/validate", '{"licenseKey":"key-1"}'))).status, 200);
	assert.equal((await deactivate.POST(post("/api/licenses/deactivate", ""))).status, 200);
});
