import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, "src/app/api/deliverability", file), "utf8");

// Every admin route authorises through authorizeDomainAdmin (session, domain-admin permission, a domain this admin may manage); writes also check the origin.
for (const [file, method, write] of [["[domainId]/tls/route.ts", "GET", false], ["[domainId]/tls-rpt/route.ts", "PUT", true], ["[domainId]/mta-sts/route.ts", "GET", false], ["[domainId]/mta-sts/route.ts", "PUT", true], ["[domainId]/mta-sts/verified/route.ts", "POST", true]]) {
	test(`${file} ${method} authorises as a domain admin${write ? " with the origin check" : ""} before anything else`, () => {
		const source = read(file);
		assert.match(source, new RegExp(`export async function ${method}\\(`));
		const handler = source.slice(source.indexOf(`export async function ${method}(`));
		const call = new RegExp(`authorizeDomainAdmin\\(env, request, domainId, ${write}\\)`).exec(handler);
		assert.ok(call, "calls authorizeDomainAdmin with the right write flag");
		assert.ok(handler.indexOf("if (access.error) return access.error;") > call.index);
		assert.ok(handler.indexOf("access.error") < handler.search(/(get|update|mark)[A-Z]\w+\(env/));
	});
}

test("the MTA-STS status compares the live MX records with the stored list, only once a policy is published", () => {
	const source = read("[domainId]/mta-sts/route.ts");
	assert.match(source, /mxDrift: state\.policyId \? await mxDrift\(domain, state\) : null/);
});
