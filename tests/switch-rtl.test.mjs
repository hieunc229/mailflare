import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/components/ui/switch.tsx"), "utf8");

test("the switch thumb travels toward the end edge in both reading directions", () => {
	assert.match(source, /translate-x-\[21px\] rtl:-translate-x-\[21px\]/, "on position mirrors in RTL");
	assert.match(source, /translate-x-0\.5 rtl:-translate-x-0\.5/, "off inset mirrors in RTL");
});
