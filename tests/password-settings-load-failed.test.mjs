import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("a failed security-status load shows the load message, not the password-change error", () => {
	const source = readFileSync("src/components/settings/password-settings.tsx", "utf8");
	const line = source.split("\n").find((l) => l.includes("if (!status) return"));
	assert.ok(line?.includes('loadFailed ? t("mfa.loadFailed")'));
});
