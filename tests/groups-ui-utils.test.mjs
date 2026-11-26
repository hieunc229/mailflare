import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { nextIndex, readApiError, GroupsApiError, isLicenseRequired, isMigrationRequired } = await loadComponent("src/app/(admin)/groups/utils.ts", {
	"@/lib/auth/client": `export async function authFetch() {}`,
});

test("nextIndex wraps and handles an empty list", () => {
	assert.equal(nextIndex(-1, 1, 3), 0);
	assert.equal(nextIndex(-1, -1, 3), 2);
	assert.equal(nextIndex(2, 1, 3), 0);
	assert.equal(nextIndex(0, -1, 3), 2);
	assert.equal(nextIndex(0, 1, 0), -1);
});

test("API errors keep readable text and codes for the special states", () => {
	assert.equal(readApiError({ error: "Nope" }, "fallback"), "Nope");
	assert.equal(readApiError({ error: { fieldErrors: {} } }, "fallback"), "fallback", "a zod error object is not shown");
	assert.equal(readApiError(null, "fallback"), "fallback");
	assert.equal(isLicenseRequired(new GroupsApiError("x", 403, "LICENSE_REQUIRED")), true);
	assert.equal(isMigrationRequired(new GroupsApiError("x", 503, "MIGRATION_REQUIRED")), true);
	assert.equal(isLicenseRequired(new Error("x")), false);
});
