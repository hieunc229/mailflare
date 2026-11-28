import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const inboxRules = readFileSync("src/components/settings/inbox-rules.tsx", "utf8");
const domainRouting = readFileSync("src/components/settings/domain-routing/domain-routing.tsx", "utf8");

test("rule delete buttons confirm first", () => {
	for (const source of [inboxRules, domainRouting]) {
		assert.match(source, /import \{ confirmDestructive \} from "@\/components\/ui\/confirm-dialog"/);
		assert.ok(source.includes("await confirmDestructive("));
	}
	assert.ok(!inboxRules.includes("onClick={() => remove.mutate(rule.id)}"));
	assert.ok(!domainRouting.includes("onClick={() => onDelete(rule.id)}"));
	const hidden = inboxRules.split("\n").find((line) => line.includes("opacity-0"));
	assert.ok(hidden?.includes("[@media(pointer:coarse)]:opacity-100") && hidden.includes("max-md:opacity-100"));
});
