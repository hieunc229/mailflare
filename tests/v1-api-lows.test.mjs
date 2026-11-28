import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("v1 dns setup adopts the zone before setup", () => {
	const text = read("src/app/api/v1/domains/[id]/dns/setup/route.ts");
	assert.match(text, /import \{ adoptCloudflareZone \} from "@\/lib\/domains\/adopt-zone"/);
	const adopt = text.indexOf("adoptCloudflareZone(");
	assert.ok(adopt > 0 && adopt < text.indexOf("setupDomainDnsRecord("));
});

test("v1 messages list reads the user from the api key", () => {
	const text = read("src/app/api/v1/messages/route.ts");
	assert.doesNotMatch(text, /db\.select\(\)\.from\(users\)/);
	assert.match(text, /user\.disabled/);
});
