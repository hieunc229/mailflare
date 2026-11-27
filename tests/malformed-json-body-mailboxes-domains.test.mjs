import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(root, "tests", ".tmp-malformed-json-create-"));
after(() => rmSync(temporary, { recursive: true, force: true }));

// A malformed or empty JSON body must answer 400, not throw out of the handler as a 500.
const mocks = {
	"next/server": "export const NextResponse={json:(body,init)=>Response.json(body,init)};export const NextRequest=class{};",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/auth/cookies": "export async function requireUser(){return {id:'user-1',role:'admin',email:'owner@mail.test',name:'Owner'}}",
	"@/lib/auth/admin": "export function canManageDomains(){return true}",
	"@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return true}",
	"next/headers": "export async function cookies(){return {get:()=>undefined,set:()=>undefined}}export async function headers(){return new Headers()}",
	"next/cache": "export function revalidatePath(){}export function revalidateTag(){}export function unstable_cache(fn){return fn}",
};

await build({
	entryPoints: {
		mailboxes: join(root, "src/app/api/mailboxes/route.ts"),
		domains: join(root, "src/app/api/domains/route.ts"),
		validators: join(root, "src/lib/validators.ts"),
	},
	outdir: temporary,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	alias: { "@": join(root, "src") },
	packages: "external",
	logLevel: "silent",
	plugins: [{
		name: "malformed-json-fixtures",
		setup(builder) {
			builder.onResolve(
				{ filter: /^(next\/(server|headers|cache)|@\/lib\/cloudflare|@\/lib\/auth\/(cookies|admin|origin))$/ },
				(args) => ({ path: args.path, namespace: "mock" }),
			);
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
});

const { POST: createMailbox } = await import(pathToFileURL(join(temporary, "mailboxes.mjs")).href);
const { POST: addDomain } = await import(pathToFileURL(join(temporary, "domains.mjs")).href);
const { mailboxSchema, addDomainSchema } = await import(pathToFileURL(join(temporary, "validators.mjs")).href);

const routes = [["POST /api/mailboxes", createMailbox], ["POST /api/domains", addDomain]];
const post = (handler, body) => handler(new Request("https://mail.test/api/thing", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body,
}));

test("a malformed or empty JSON body is a 400, not a thrown parse error", async () => {
	for (const [name, handler] of routes) {
		for (const body of ["{", "", "not json"]) {
			const response = await post(handler, body);
			assert.equal(response.status, 400, `${name} with body ${JSON.stringify(body)}`);
		}
	}
});

test("a well-formed body still reaches the schema and reports field errors", async () => {
	for (const [name, handler] of routes) {
		const response = await post(handler, JSON.stringify({}));
		assert.equal(response.status, 400, name);
		assert.ok((await response.json()).error, `${name} carries the zod error`);
	}
});

test("the schemas reject the null the catch falls back to", () => {
	assert.equal(mailboxSchema.safeParse(null).success, false);
	assert.equal(addDomainSchema.safeParse(null).success, false);
});
