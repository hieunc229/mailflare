import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/app/api/messages/[messageId]/invite/route.ts"), "utf8");
// Pull the exact pattern out of the route so the test cannot drift from it.
const match = /const SINGLE_ADDRESS = \/(.+)\/;/.exec(source);
const SINGLE_ADDRESS = match && new RegExp(match[1]);

test("reply recipient pattern accepts one plain address only", () => {
	assert.ok(SINGLE_ADDRESS, "pattern found in route");
	assert.ok(SINGLE_ADDRESS.test("organizer@example.com"));
	for (const bad of ["a@evil.com, b@example.com", "a@x.com;b@y.com", "Organizer <o@example.com>", "a@b@c.com", "a@b.com\nbcc:c@d.com", "\"a@b.com\"@example.com"]) {
		assert.equal(SINGLE_ADDRESS.test(bad), false, bad);
	}
});

test("the route sends the reply to a one-element list", () => {
	assert.match(source, /to: \[replyTo\]/);
});
