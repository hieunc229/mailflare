import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("mysql update without returning does not need a primary key", () => {
	const source = readFileSync("src/db/compat.ts", "utf8");
	assert.doesNotMatch(source, /const \{ column \} = primaryKey\(this\.table\);\n\s*\/\/ Rows are identified/);
});
