import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("service passes the preflight zone to provisioning", () => {
	assert.match(read("src/lib/domains/service.ts"), /provisionDomainOnCloudflare\(env, hostname, \{[\s\S]*?zone: preflightZone/);
});

test("provisioning uses the supplied zone before looking it up", () => {
	assert.match(read("src/lib/domains/provision.ts"), /options\?\.zone \?\? await findZoneByHostname/);
});

test("mx predicate strips a trailing dot", () => {
	assert.match(read("src/lib/domains/mx-records.ts"), /replace\(\/\\\.\$\/, ""\)/);
});
