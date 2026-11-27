import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(project, "tests", ".tmp-malformed-form-"));
after(() => { rmSync(temporary, { recursive: true, force: true }); });

// A malformed (non-multipart) body must be a 400, not an unhandled formData()
// throw that becomes a 500. Sibling avatar routes already follow this shape.
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/auth/cookies": "export async function requireUser(){return {id:'admin',role:'admin',isPrimaryAdmin:true}}",
	"@/lib/auth/admin": "export function assertPrimaryAdmin(){}",
	"@/lib/branding/service": "export async function getBranding(){return {}} export async function updateBranding(env,input){return {appName:input.appName}}",
	"branding/utils": "export const MAX_BRANDING_ICON_SIZE=2097152;export const BRANDING_ICON_TYPES=['image/png'];export function isBrandingIcon(){return false}",
	"@/app/api/accounts/utils": "export async function requireTeamAdmin(){return {env:{},user:{id:'admin'},error:null}}",
	"accounts/[id]/utils": "export async function selectAccountById(){return {id:'acc-1',createdByUserId:'admin'}}",
	"@/lib/avatar-images": "export function getAvatarImageResponse(){return new Response('img')} export function getOptimizedAvatarFiles(){return {full:{},preview:{}}} export async function storeAvatarImages(){}",
	"@/app/api/profile/avatar/utils": "export function avatarKeyFor(){return 'key-1'}",
	"@/db": "export function getDb(){return globalThis.malformedFormDb}",
	"@/db/schema": "export const users={};",
};

await build({
	stdin: {
		contents: `export * as branding from './src/app/api/branding/route';export * as accountAvatar from './src/app/api/accounts/[id]/avatar/route';`,
		resolveDir: project,
		loader: "ts",
	},
	outfile: join(temporary, "routes.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(project, "src") },
	plugins: [{ name: "malformed-form-mocks", setup(builder) {
		builder.onResolve({ filter: /.*/ }, (args) => {
			let key = args.path;
			// `./utils` inside branding/route.ts is that folder's own utils; inside
			// accounts/[id]/avatar/ it is avatar/utils.ts, bundled for real.
			if (args.path === "./utils" && args.importer.includes("branding/")) key = "branding/utils";
			// `../../utils` from accounts/[id]/avatar/* is src/app/api/accounts/utils;
			// `../utils` is accounts/[id]/utils, which selectAccountById lives in.
			else if (args.path === "../../utils" && args.importer.includes("accounts/[id]/")) key = "@/app/api/accounts/utils";
			else if (args.path === "../utils" && args.importer.includes("accounts/[id]/")) key = "accounts/[id]/utils";
			return key in mocks ? { path: key, namespace: "mock" } : undefined;
		});
		builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
	} }],
	logLevel: "silent",
});
const { branding, accountAvatar } = await import(pathToFileURL(join(temporary, "routes.mjs")).href);

const notMultipart = (path, method) => new Request(`https://mail.test${path}`, { method, headers: { "Content-Type": "application/json" }, body: "{not valid json" });
const context = (id) => ({ params: Promise.resolve({ id }) });

test("PUT /api/branding answers 400 for a non-multipart body", async () => {
	const response = await branding.PUT(notMultipart("/api/branding", "PUT"));
	assert.equal(response.status, 400);
	assert.equal((await response.json()).error, "Expected multipart form data");
});

test("POST /api/accounts/[id]/avatar answers 400 for a non-multipart body", async () => {
	const response = await accountAvatar.POST(notMultipart("/api/accounts/acc-1/avatar", "POST"), context("acc-1"));
	assert.equal(response.status, 400);
	assert.equal((await response.json()).error, "Expected multipart form data");
});

test("well-formed multipart bodies still reach the handlers", async () => {
	globalThis.malformedFormDb = { update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }) };
	const multipart = (path, method, form) => new Request(`https://mail.test${path}`, { method, body: form });
	const brandingForm = new FormData();
	brandingForm.set("appName", "Mailflare");
	assert.equal((await branding.PUT(multipart("/api/branding", "PUT", brandingForm))).status, 200);
	const avatarForm = new FormData();
	assert.equal((await accountAvatar.POST(multipart("/api/accounts/acc-1/avatar", "POST", avatarForm), context("acc-1"))).status, 200);
});
