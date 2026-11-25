import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the routes turn the refusal into a translated 409, and the provider switch is guarded", () => {
	const read = (path) => readFileSync(join(root, path), "utf8");
	const helper = read("src/lib/deliverability/mta-sts-block-response.ts");
	assert.match(helper, /getServerTranslator\(\)/);
	assert.match(helper, /status: error\.status/);
	for (const key of ["mtasts.block.enforce", "mtasts.block.published", "mtasts.block.tlsRpt"]) assert.ok(helper.includes(key), key);
	for (const path of ["src/app/api/domains/[id]/dns/setup/route.ts", "src/app/api/v1/domains/[id]/dns/setup/route.ts", "src/app/api/domains/[id]/receiving/[provider]/route.ts", "src/app/api/domains/[id]/receiving/route.ts", "src/app/api/domains/[id]/route.ts", "src/app/api/v1/domains/[id]/route.ts", "src/app/api/domains/route.ts", "src/app/api/v1/domains/route.ts", "src/app/api/domains/[id]/sending/route.ts"]) {
		assert.match(read(path), /mtaStsBlockedResponse\(/, path);
	}
	const receiving = read("src/app/api/domains/[id]/receiving/route.ts");
	assert.ok(receiving.indexOf("assertMxChangeAllowed(env, domain)") < receiving.indexOf(".set({ receivingProvider"), "the guard runs before the provider is saved");
});
