import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "image-response-test-"));
const mocks = {
	"@/db": "export function getDb() { return globalThis.imageResponseTest.db; }",
	"@/lib/cloudflare": "export async function getEnvAsync() { return globalThis.imageResponseTest.env; }",
	"@/lib/branding/service": "export const APP_SETTINGS_ID = 'app';",
	"@/lib/licenses/service": "export async function getLicenseEntitlements() { return { canCustomizeBranding: globalThis.imageResponseTest.custom }; }",
};
await build({
	stdin: {
		contents: `export { getAvatarImageResponse } from './src/lib/avatar-images.ts';
			export { GET as getBrandingIcon } from './src/app/api/branding/icon/route.ts';`,
		resolveDir: root,
		sourcefile: "image-response-test.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
	plugins: [{ name: "image-dependencies", setup(builder) {
		builder.onResolve({ filter: /^@\// }, ({ path }) => path in mocks ? { path, namespace: "mock" } : undefined);
		builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: mocks[path], loader: "js" }));
	} }],
});
const { getAvatarImageResponse, getBrandingIcon } = await import(pathToFileURL(join(directory, "entry.mjs")).href);
after(() => {
	rmSync(directory, { recursive: true, force: true });
	delete globalThis.imageResponseTest;
});

const avatarBucket = () => ({
	get: async () => ({ body: "avatar", httpMetadata: { contentType: "image/webp" }, httpEtag: '"avatar-etag"' }),
});

test("unversioned avatars can be reused for five minutes without a server round trip, but never publicly", async () => {
	for (const suffix of ["", "?variant=preview"]) {
		const response = await getAvatarImageResponse(new Request(`https://mail.test/api/contacts/avatar${suffix}`), avatarBucket(), "avatar");
		assert.equal(response.headers.get("Cache-Control"), "private, max-age=300");
		assert.equal(response.headers.get("Content-Type"), "image/webp");
		assert.equal(response.headers.get("Vary"), "Cookie, Authorization");
		assert.equal(await response.text(), "avatar");
	}
});

test("versioned avatars retain immutable private caching", async () => {
	const response = await getAvatarImageResponse(new Request("https://mail.test/api/contacts/avatar?v=123"), avatarBucket(), "avatar");
	assert.equal(response.headers.get("Cache-Control"), "private, max-age=31536000, immutable");
});

test("expired avatar revalidation retains ETag and refreshes the private freshness period", async () => {
	const response = await getAvatarImageResponse(new Request("https://mail.test/api/contacts/avatar", {
		headers: { "If-None-Match": '"avatar-etag"' },
	}), avatarBucket(), "avatar");
	assert.equal(response.status, 304);
	assert.equal(response.headers.get("ETag"), '"avatar-etag"');
	assert.equal(response.headers.get("Cache-Control"), "private, max-age=300");
	assert.equal(await response.text(), "");
});

function brandingState({ custom = false, iconKey = null, assetStatus = 200, object = null } = {}) {
	const query = { select() { return this; }, from() { return this; }, where() { return this; }, async limit() { return [{ iconKey }]; } };
	globalThis.imageResponseTest = {
		custom, db: query,
		env: {
			ASSETS: { async fetch() { return new Response("packaged-icon", {
				status: assetStatus,
				headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=0, must-revalidate", ETag: '"packaged-etag"' },
			}); } },
			BUCKET: { async get() { return object; } },
		},
	};
}
const iconRequest = () => new Request("https://mail.test/api/branding/icon");

test("default branding icon overrides revalidation-only asset headers for unlicensed and licensed installs", async () => {
	for (const custom of [false, true]) {
		brandingState({ custom });
		const response = await getBrandingIcon(iconRequest());
		assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
		assert.equal(response.headers.get("Content-Type"), "image/png");
		assert.equal(response.headers.get("ETag"), '"packaged-etag"');
		assert.equal(await response.text(), "packaged-icon");
	}
});

test("missing custom icon uses the same cacheable fallback", async () => {
	brandingState({ custom: true, iconKey: "missing" });
	const response = await getBrandingIcon(iconRequest());
	assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
	assert.equal(await response.text(), "packaged-icon");
});

test("custom branding icon keeps its existing cache policy and content", async () => {
	brandingState({ custom: true, iconKey: "custom", object: { body: "custom-icon", httpMetadata: { contentType: "image/webp" } } });
	const response = await getBrandingIcon(iconRequest());
	assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
	assert.equal(response.headers.get("Content-Type"), "image/webp");
	assert.equal(await response.text(), "custom-icon");
});

test("asset failures do not acquire an hour-long freshness period", async () => {
	brandingState({ assetStatus: 503 });
	const response = await getBrandingIcon(iconRequest());
	assert.equal(response.status, 503);
	assert.equal(response.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
});
