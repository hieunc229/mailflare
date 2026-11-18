import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-unauthorized-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/auth/unauthorized.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
});
const { UnauthorizedError } = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const { resolveAppRouteHandlerSpecialError } = await import(
	pathToFileURL(join(root, "node_modules/vinext/dist/server/app-route-handler-policy.js")).href
);

test("an escaped UnauthorizedError is answered with 401 by the route runtime", () => {
	const error = new UnauthorizedError();
	assert.ok(error instanceof Error);
	assert.equal(error.message, "Unauthorized");
	assert.deepEqual(resolveAppRouteHandlerSpecialError(error, "https://mail.test/api/drafts", {}), { kind: "status", statusCode: 401 });
});

test("a bare Error is not special-cased, so it stays a 500", () => {
	assert.equal(resolveAppRouteHandlerSpecialError(new Error("Unauthorized"), "https://mail.test/", {}), null);
});
