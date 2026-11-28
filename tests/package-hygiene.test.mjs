import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test(".dockerignore excludes docs, tests, changelog and sponsors", () => {
	const lines = readFileSync(".dockerignore", "utf8").split("\n").map((line) => line.trim());
	for (const entry of ["docs", "tests", "e2e", "changelog", "sponsors"]) assert.ok(lines.includes(entry), entry + " missing from .dockerignore");
});
