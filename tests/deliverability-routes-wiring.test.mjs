import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, "src/app/api/deliverability", file), "utf8");

// Every admin route authorises through authorizeDomainAdmin (session, domain-admin permission, a domain this admin may manage); writes also check the origin.
for (const [file, method, write] of [["[domainId]/tls/route.ts", "GET", false], ["[domainId]/tls-rpt/route.ts", "PUT", true]]) {
	test(`${file} ${method} authorises as a domain admin${write ? " with the origin check" : ""} before anything else`, () => {
		const source = read(file);
		assert.match(source, new RegExp(`export async function ${method}\\(`));
		const call = new RegExp(`authorizeDomainAdmin\\(env, request, domainId, ${write}\\)`).exec(source);
		assert.ok(call, "calls authorizeDomainAdmin with the right write flag");
		assert.ok(source.indexOf("if (access.error) return access.error;") > call.index);
		assert.ok(source.indexOf("access.error") < source.search(/get[A-Z]\w+\(env|update[A-Z]\w+\(env/));
	});
}
