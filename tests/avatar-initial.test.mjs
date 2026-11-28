import assert from "node:assert/strict";
import test from "node:test";
import { avatarInitial } from "../src/lib/avatar-colors.ts";

test("avatarInitial keeps whole characters and trims leading space", () => {
	assert.equal(avatarInitial("😀 Sam"), "😀");
	assert.equal(avatarInitial("  sam"), "S");
	assert.equal(avatarInitial(""), "");
});
