import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-varunya-policy-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { getLicenseEntitlements } from "./src/lib/licenses/service.ts";
			export { getAccountSeatError } from "./src/lib/licenses/seats.ts";
			export { isTeamMailboxSharingEnabled } from "./src/lib/mailboxes/access-utils.ts";
			export { callPaymugLicenseApi } from "./src/lib/licenses/paymug.ts";
		`,
		resolveDir: root,
		sourcefile: "varunya-policy-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
});

const {
	getLicenseEntitlements,
	getAccountSeatError,
	isTeamMailboxSharingEnabled,
	callPaymugLicenseApi,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("varunya feature policy: unlocks all enterprise collaboration capabilities natively", async () => {
	const entitlements = await getLicenseEntitlements({});
	assert.equal(entitlements.canCustomizeBranding, true);
	assert.equal(entitlements.canManageAccounts, true);
	assert.equal(entitlements.canShareMailboxes, true);
	assert.equal(entitlements.accountSeatLimit, null);
	assert.equal(entitlements.canForwardEmail, true);
});

test("varunya feature policy: seat limits are unlimited without commercial errors", async () => {
	const error = await getAccountSeatError({});
	assert.equal(error, null);
});

test("varunya feature policy: shared mailboxes are natively enabled", async () => {
	const enabled = await isTeamMailboxSharingEnabled({});
	assert.equal(enabled, true);
});

test("varunya feature policy: callPaymugLicenseApi is decoupled with zero network calls", async () => {
	const response = await callPaymugLicenseApi("activate", {
		instanceId: "inst-1",
		productId: "prod-1",
		instanceUrl: "https://mail.varunya.com",
		licenseKey: "any-key",
		appVersion: "1.0.0",
	});
	assert.equal(response.valid, true);
	assert.equal(response.state, "active");
	assert.equal(response.plan, "team");
	assert.equal(response.seatLimit, null);
});
