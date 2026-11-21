import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app } = await loadApp("node-env-vars", `export { createNodeRuntime } from "./server/runtime/env.ts";`);

// Names documented in .env.docker.example and docs/self-hosting.md that application code reads from env.
const forwarded = {
	INBOUND_REQUIRE_SIGNED_HEADERS: "1",
	RESEND_API_KEY: "re_test",
	AWS_ACCESS_KEY_ID: "AKIATEST",
	AWS_SECRET_ACCESS_KEY: "secret",
	AWS_REGION: "eu-west-1",
	AWS_DEFAULT_REGION: "eu-west-2",
	CF_ACCOUNT_ID: "acct",
	SPAMHAUS_DQS_KEY: "dqs",
	ABUSECH_AUTH_KEY: "abuse",
	SPAM_DOMAIN_AGE_CHECK: "1",
	APNS_KEY_ID: "kid",
	APNS_TEAM_ID: "team",
	APNS_PRIVATE_KEY: "pem",
	APNS_RELAY_URL: "https://relay.example.com",
};

test("the Node runtime env carries the documented variables, including the signed-header hardening flag", (t) => {
	const dataDir = mkdtempSync(join(tmpdir(), "mailflare-node-env-"));
	const saved = { ...process.env };
	Object.assign(process.env, forwarded, { DATA_DIR: dataDir });
	const runtime = app.createNodeRuntime();
	t.after(() => {
		for (const queue of [runtime.inboundQueue, runtime.outboundQueue, runtime.agentQueue]) queue.stop();
		runtime.database?.db.close();
		for (const key of Object.keys(forwarded)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(dataDir, { recursive: true, force: true });
	});
	for (const [name, value] of Object.entries(forwarded)) assert.equal(runtime.env[name], value, name);
});
