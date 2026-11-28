import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app } = await loadApp("api-features-misc-lows", 'export { getSendErrorStatus } from "./src/app/api/send/error-utils.ts";');
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("send maps the recipient-count error to 400", () => {
	assert.equal(app.getSendErrorStatus("A message can have at most 50 recipients per field"), 400);
	assert.equal(app.getSendErrorStatus("A message can have at most 50 recipients"), 400);
	assert.equal(app.getSendErrorStatus("boom"), 500);
});

test("templates read the body with a cap and check types", () => {
	const text = read("src/app/api/templates/route.ts");
	assert.match(text, /readJsonBody\(request, 1024 \* 1024\)/);
	assert.doesNotMatch(text, /request\.json\(\)/);
});

test("gravatar fetches are bounded", () => {
	assert.ok(read("src/lib/contacts/gravatar.ts").split("AbortSignal.timeout(").length - 1 >= 2);
});
