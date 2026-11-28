import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-auth-lows-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const read = (path) => readFileSync(join(root, path), "utf8");

const bundle = async (name, contents, mocks = {}) => {
	await build({
		stdin: { contents, resolveDir: root, loader: "ts" },
		outfile: join(outDir, `${name}.mjs`),
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		alias: { "@": join(root, "src") },
		plugins: [{
			name: "mock-deps",
			setup(builder) {
				const names = Object.keys(mocks).map((key) => key.replace(/[/.-]/g, "\\$&")).join("|");
				if (!names) return;
				builder.onResolve({ filter: new RegExp(`^(${names})$`) }, (args) => ({ path: args.path, namespace: "mock" }));
				builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
			},
		}],
		logLevel: "silent",
	});
	return import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
};

const { hashPassword, verifyPasswordAsync } = await bundle("password", "export * from './src/lib/auth/password';");
const { authenticateApiRequest } = await bundle("keyauth", "export { authenticateApiRequest } from './src/lib/api/key-auth';", {
	"@/db": "export function getDb(){return {}}",
	"@/db/schema": "export const apiKeys={};export const mcpKeyMailboxes={};export const users={};",
	"@/lib/api/find-api-key": "export async function findApiKeyForSecret(db, secret){globalThis.__tried.push(secret);return null}",
	"@/lib/api-keys": "export const parseScopes=()=>[]",
	"@/lib/api/scopes": "export const ADMIN_API_KEY_SCOPES=[]",
	"@/lib/auth/client-ip": "export const getClientIp=()=>null",
});

test("verifyPasswordAsync is false for a missing hash and for a wrong password", async () => {
	assert.equal(await verifyPasswordAsync("x", null), false);
	assert.equal(await verifyPasswordAsync("x", "!passkey-only"), false);
	const hash = hashPassword("y");
	assert.equal(await verifyPasswordAsync("x", hash), false);
	assert.equal(await verifyPasswordAsync("y", hash), true);
});

test("login and device check the password before the user", () => {
	for (const path of ["src/app/api/auth/login/route.ts", "src/app/api/auth/device/route.ts"]) {
		const text = read(path);
		assert.match(text, /verifyPasswordAsync\(/, path);
		assert.doesNotMatch(text, /!user \|\| !verifyPassword/, path);
	}
});

test("resolveAccounts reads the primary", () => {
	assert.match(read("src/lib/auth/accounts.ts"), /DB_PRIMARY/);
});

test("webauthn verify does not fetch branding", () => {
	const text = read("src/lib/auth/webauthn/service.ts");
	for (const name of ["verifyPasskeyRegistrationResponse", "verifyPasskeyAuthentication"]) {
		const start = text.indexOf(`export async function ${name}(`);
		const end = text.indexOf("\nexport ", start + 1);
		const body = text.slice(start, end === -1 ? undefined : end);
		assert.match(body, /getWebAuthnOrigin\(/, name);
		assert.doesNotMatch(body, /getWebAuthnConfig\(/, name);
	}
});

test("jmap basic retries a grouped app password without spaces and dashes", async () => {
	globalThis.__tried = [];
	const basic = `Basic ${btoa("user:abcd-efgh ijkl")}`;
	await authenticateApiRequest({ DB: "db" }, new Request("https://x.test/jmap", { headers: { Authorization: basic } }));
	assert.deepEqual(globalThis.__tried, ["abcd-efgh ijkl", "abcdefghijkl"]);
	globalThis.__tried = [];
	await authenticateApiRequest({ DB: "db" }, new Request("https://x.test/jmap", { headers: { Authorization: `Basic ${btoa("user:plainkey")}` } }));
	assert.deepEqual(globalThis.__tried, ["plainkey"]);
});
