import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-tenancy-scope-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/tenancy/scope.ts")],
	outfile: join(outDir, "scope.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	logLevel: "silent",
});
const { scopeBucket, routeBucket, isFileKey, scopeNamespace, scopeQueue, TENANT_QUEUE_FIELD } = await import(pathToFileURL(join(outDir, "scope.mjs")).href);

await build({ entryPoints: [join(root, "src/lib/tenancy/plans.ts")], outfile: join(outDir, "plans.mjs"), bundle: true, format: "esm", platform: "node", logLevel: "silent" });
const { PLANS, tenantLimitsFor, planForTeamSize, TRIAL_EMAILS_PER_USER_PER_DAY, TRIAL_DOMAINS } = await import(pathToFileURL(join(outDir, "plans.mjs")).href);

function memoryBucket() {
	const objects = new Map();
	return {
		objects,
		async put(key, value) { objects.set(key, value); return { key, size: String(value).length }; },
		async get(key) { return objects.has(key) ? { key, text: async function () { return objects.get(this.key.startsWith("t/") ? this.key : key); } } : null; },
		async head(key) { return objects.has(key) ? { key } : null; },
		async delete(keys) { for (const key of [keys].flat()) objects.delete(key); },
		async list({ prefix = "" } = {}) {
			const matched = [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key }));
			return { objects: matched, delimitedPrefixes: [], truncated: false };
		},
	};
}

test("a tenant's bucket keys live under its own prefix and never show it", async () => {
	const shared = memoryBucket();
	const a = scopeBucket(shared, "t/a/");
	const b = scopeBucket(shared, "t/b/");
	await a.put("config/signing-secret", "secret-a");
	await b.put("config/signing-secret", "secret-b");
	assert.deepEqual([...shared.objects.keys()].sort(), ["t/a/config/signing-secret", "t/b/config/signing-secret"]);
	assert.equal((await a.head("config/signing-secret")).key, "config/signing-secret");
	assert.deepEqual((await a.list({ prefix: "config/" })).objects.map((object) => object.key), ["config/signing-secret"]);
	assert.equal(await a.get("missing"), null);
	await a.delete(["config/signing-secret"]);
	assert.deepEqual([...shared.objects.keys()], ["t/b/config/signing-secret"]);
});

test("queue messages carry the tenant that sent them", async () => {
	const sent = [];
	const queue = scopeQueue({ send: async (body) => sent.push(body), sendBatch: async (messages) => sent.push(...messages.map((m) => m.body)) }, "acme");
	await queue.send({ kind: "email.scheduled" });
	await queue.sendBatch([{ body: { kind: "import.run" } }]);
	assert.deepEqual(sent.map((body) => body[TENANT_QUEUE_FIELD]), ["acme", "acme"]);
	assert.equal(sent[0].kind, "email.scheduled");
});

test("realtime hubs are named per tenant", () => {
	const names = [];
	const namespace = scopeNamespace({ getByName: (name) => names.push(name), idFromName: (name) => name }, "acme");
	namespace.getByName("usr_1");
	assert.deepEqual(names, ["acme:usr_1"]);
	assert.equal(namespace.idFromName("usr_1"), "acme:usr_1");
});

test("attachments and Drive files go to the files bucket, everything else stays in R2", async () => {
	const r2 = memoryBucket();
	const b2 = memoryBucket();
	const bucket = routeBucket(scopeBucket(r2, "t/a/"), scopeBucket(b2, "t/a/"));
	await bucket.put("attachments/m1/a1/report.pdf", "pdf");
	await bucket.put("drive/u1/f1", "file");
	await bucket.put("raw/m1.eml", "mime");
	await bucket.put("config/signing-secret", "secret");
	assert.deepEqual([...b2.objects.keys()].sort(), ["t/a/attachments/m1/a1/report.pdf", "t/a/drive/u1/f1"]);
	assert.deepEqual([...r2.objects.keys()].sort(), ["t/a/config/signing-secret", "t/a/raw/m1.eml"]);
	assert.equal((await bucket.head("drive/u1/f1")).key, "drive/u1/f1");
	assert.equal(await bucket.head("raw/m1.eml") !== null, true);
	assert.deepEqual((await bucket.list({ prefix: "drive/" })).objects.map((object) => object.key), ["drive/u1/f1"]);
	await bucket.delete(["drive/u1/f1", "raw/m1.eml"]);
	assert.deepEqual([...b2.objects.keys()], ["t/a/attachments/m1/a1/report.pdf"]);
	assert.deepEqual([...r2.objects.keys()], ["t/a/config/signing-secret"]);
	assert.equal(isFileKey("attachments/x"), true);
	assert.equal(isFileKey("drive-avatars/x"), false);
});

test("plan limits: tier numbers with the operator's overrides on top, unknown tiers get the smallest plan", () => {
	assert.deepEqual(tenantLimitsFor("team"), { users: 10, domains: 30, storageBytes: 1024 * 2 ** 30, emailsPerUserPerDay: 200 });
	assert.equal(tenantLimitsFor("solo").users, 1);
	assert.equal(tenantLimitsFor("solo").storageBytes, 50 * 2 ** 30);
	assert.equal(tenantLimitsFor("business").storageBytes, 5 * 1024 * 2 ** 30);
	assert.equal(tenantLimitsFor("business", { users: 80 }).users, 80);
	assert.equal(tenantLimitsFor("enterprise").users, -1);
	assert.equal(tenantLimitsFor("nonsense").users, 1);
	assert.equal(tenantLimitsFor(undefined).users, 1);
	assert.equal(planForTeamSize(1).tier, "solo");
	assert.equal(planForTeamSize(2).tier, "starter");
	assert.equal(planForTeamSize(5).tier, "starter");
	assert.equal(planForTeamSize(6).tier, "team");
	assert.equal(planForTeamSize(11).tier, "business");
	assert.equal(planForTeamSize(5000).tier, "business");
	assert.deepEqual(PLANS.map((plan) => plan.priceMonthly), [4, 16, 34, 149, null]);
});

test("the first days after activation use the trial's lower daily send limit", () => {
	const activated = 1_000_000;
	const day = 86400;
	assert.equal(TRIAL_EMAILS_PER_USER_PER_DAY, 20);
	const trial = tenantLimitsFor("team", {}, activated, false, activated + day);
	assert.equal(trial.emailsPerUserPerDay, 20);
	assert.equal(TRIAL_DOMAINS, 1);
	assert.equal(trial.domains, 1);
	assert.equal(trial.users, 3);
	assert.equal(trial.recipientsPerDay, 50);
	assert.equal(trial.trialEndsAt, activated + 7 * day);
	const after = tenantLimitsFor("team", {}, activated, false, activated + 7 * day + 1);
	assert.equal(after.emailsPerUserPerDay, 200);
	assert.equal(after.domains, 30);
	assert.equal(after.trialEndsAt, undefined);
	assert.equal(tenantLimitsFor("team", {}, null, false, activated).emailsPerUserPerDay, 200);
	assert.equal(tenantLimitsFor("enterprise", {}, activated, false, activated + day).emailsPerUserPerDay, -1);
	assert.equal(tenantLimitsFor("team", { emailsPerUserPerDay: 500 }, activated, false, activated + day).emailsPerUserPerDay, 500);
	assert.equal(tenantLimitsFor("team", { emailsPerUserPerDay: 5 }, activated, false, activated + day).emailsPerUserPerDay, 5);
	assert.equal(tenantLimitsFor("team", { domains: 5 }, activated, false, activated + day).domains, 5);
});

test("a trial that ended without a subscription locks the workspace; subscribing or an override lifts it", () => {
	const activated = 1_000_000;
	const day = 86400;
	assert.equal(tenantLimitsFor("team", {}, activated, false, activated + 7 * day + 1).trialExpired, 1);
	assert.equal(tenantLimitsFor("team", {}, activated, false, activated + day).trialExpired, undefined);
	assert.equal(tenantLimitsFor("team", {}, activated, true, activated + 30 * day).trialExpired, undefined);
	assert.equal(tenantLimitsFor("team", {}, activated, true, activated + day).trialEndsAt, undefined);
	assert.equal(tenantLimitsFor("team", { trialExpired: 0 }, activated, false, activated + 30 * day).trialExpired, undefined);
	assert.equal(tenantLimitsFor("enterprise", {}, activated, false, activated + 30 * day).trialExpired, undefined);
});
