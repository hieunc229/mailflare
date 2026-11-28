import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-route-title-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { getRouteTitleKey } from "./src/components/route-title-utils.ts";
export { isAdminPath } from "./src/components/mailbox-selector-utils.ts";`,
		resolveDir: root,
		sourcefile: "route-title-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { getRouteTitleKey, isAdminPath } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("pages are titled with the most specific matching route", () => {
	assert.equal(getRouteTitleKey("/settings"), "settings.nav.settings");
	assert.equal(getRouteTitleKey("/settings/security"), "settings.nav.security");
	assert.equal(getRouteTitleKey("/settings/api-keys"), "settings.nav.apiKeys");
	assert.equal(getRouteTitleKey("/accounts/abc/permissions"), "admin.nav.accounts");
	assert.equal(getRouteTitleKey("/domains"), "admin.nav.domains");
});

test("routes that set their own title are left alone", () => {
	for (const path of ["/inbox", "/inbox/msg_1", "/sent", "/folders/f1", "/login", "/domainsx"]) assert.equal(getRouteTitleKey(path), null);
});

test("isAdminPath covers every admin page", () => {
	for (const path of ["/admin", "/deliverability", "/accounts", "/licenses", "/branding", "/ai-usage", "/routing", "/mailboxes/abc"]) assert.equal(isAdminPath(path), true, path);
	for (const path of ["/inbox", "/settings", "/mailboxesX"]) assert.equal(isAdminPath(path), false, path);
});

test("getRouteTitleKey names the deliverability page", () => {
	assert.equal(getRouteTitleKey("/deliverability"), "admin.nav.deliverability");
	assert.equal(getRouteTitleKey("/deliverability/x"), "admin.nav.deliverability");
});

test("user pages under /agent are not admin pages", () => {
	assert.equal(isAdminPath("/agent"), true);
	assert.equal(isAdminPath("/accounts/abc"), true);
	for (const path of ["/agent/review/m1", "/agent/calendar-review"]) assert.equal(isAdminPath(path), false);
});
