import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-outbound-queue-integration-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const mocks = {
	"@/db": `
		export function getDb() {
			return globalThis.__mockDb;
		}
		export function createDb() {
			return globalThis.__mockDb;
		}
	`,
	"@/lib/email/outbound-provider": `
		export async function getOutboundProviderConfig() {
			return { provider: "resend", apiKey: "test-resend-key" };
		}
		export async function sendThroughProvider(env, config, message, idempotencyKey) {
			return globalThis.__mockSendThroughProvider(env, config, message, idempotencyKey);
		}
	`,
	"@/lib/email/attachments": `
		export async function loadMessageAttachmentContents() { return []; }
		export async function storeMessageAttachments() {}
		export function validateAttachments() { return []; }
		export function normalizeAttachmentContent(c) { return c; }
	`,
	"@/lib/email/webhooks": `
		export async function dispatchWebhooks(env, userId, event, payload) {
			globalThis.__mockWebhooks.push({ userId, event, payload });
		}
	`,
	"@/lib/mailboxes/audit": `
		export async function createAuditLog(env, data) {
			globalThis.__mockAuditLogs.push(data);
		}
	`,
	"@/lib/contacts/service": `
		export async function upsertContactsFromAddresses() {}
	`,
	"@/lib/tracking/open-tracking": `
		export async function ensureTrackingToken() { return "token"; }
		export async function getTrackingHostForSender() { return null; }
	`,
	"@/lib/follow-ups/service": `
		export async function setFollowUp() {}
	`,
	"@/lib/compose/preferences": `
		export async function getComposePreferences() { return {}; }
	`,
};

await build({
	entryPoints: [join(root, "src/lib/email/send.ts")],
	outfile: join(outDir, "send.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
	alias: { "@": join(root, "src"), "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	plugins: [{
		name: "mock-send-dependencies",
		setup(builder) {
			const names = Object.keys(mocks).map((n) => n.replace(/[/.-]/g, "\\$&")).join("|");
			builder.onResolve({ filter: new RegExp(`^(${names})$`) }, (args) => ({ path: args.path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
});

const { processOutboundQueue } = await import(pathToFileURL(join(outDir, "send.mjs")).href);

// Helpers to simulate the worker.ts queue consumer loop
function createQueueMessage(jobId, messageId, attempts = 1) {
	let acked = false;
	let retried = false;
	let retryOptions = null;
	return {
		attempts,
		body: {
			kind: "email.scheduled",
			jobId,
			messageId,
			scheduledAt: new Date(Date.now() - 5000).toISOString(),
		},
		ack() { acked = true; },
		retry(opts) { retried = true; retryOptions = opts; },
		get isAcked() { return acked; },
		get isRetried() { return retried; },
		get retryOptions() { return retryOptions; },
	};
}

async function runQueueConsumer(env, msg) {
	try {
		await processOutboundQueue(env, msg.body, msg.attempts);
		msg.ack();
	} catch (err) {
		msg.retry({ delaySeconds: 10 });
		throw err;
	}
}

// In-memory state harness
let dbState;

beforeEach(() => {
	globalThis.__mockWebhooks = [];
	globalThis.__mockAuditLogs = [];
	dbState = {
		job: {
			id: "job-123",
			messageId: "msg-123",
			status: "queued",
			scheduledAt: new Date(Date.now() - 5000),
			payload: JSON.stringify({
				userId: "user-1",
				from: "sender@varunyamail.com",
				to: "recipient@example.com",
				subject: "Integration Test",
				text: "Hello from test",
			}),
			error: null,
		},
		message: {
			id: "msg-123",
			mailboxId: "mbx-1",
			status: "queued",
			providerMessageId: null,
			threadId: null,
		},
	};

	globalThis.__mockDb = {
		select: (_fields) => ({
			from: (_table) => ({
				where: (_cond) => ({
					limit: (_n) => Promise.resolve(dbState.job ? [dbState.job] : []),
				}),
			}),
		}),
		update: (table) => ({
			set: (values) => ({
				where: (_cond) => ({
					returning: (_ret) => {
						// claimJob check: only transition if current status is queued
						if (values.status === "sending") {
							if (dbState.job && dbState.job.status === "queued") {
								dbState.job.status = "sending";
								return Promise.resolve([{ id: dbState.job.id }]);
							}
							return Promise.resolve([]);
						}
						return Promise.resolve([]);
					},
					then: (resolve) => {
						// Determine if updating outbound_jobs or messages
						const tableName = table?.[Symbol.for("drizzle:Name")] ?? table?.name ?? "";
						if (tableName.includes("outbound") || values.status === "queued" || values.error !== undefined) {
							Object.assign(dbState.job, values);
						}
						if (tableName.includes("message") || values.providerMessageId !== undefined) {
							Object.assign(dbState.message, values);
						}
						resolve();
					},
				}),
			}),
		}),
	};
});

test("1. Successful delivery: queued -> sending -> sent with queue message acknowledged", async () => {
	const env = {};
	globalThis.__mockSendThroughProvider = async (_env, _config, _msg, _idempotencyKey) => {
		return { messageId: "<resend-id-success-123>" };
	};

	const msg = createQueueMessage("job-123", "msg-123", 1);
	await runQueueConsumer(env, msg);

	// Assert final states
	assert.equal(dbState.job.status, "sent");
	assert.equal(dbState.job.error, null);
	assert.equal(dbState.message.status, "sent");
	assert.equal(dbState.message.providerMessageId, "<resend-id-success-123>");

	// Assert queue ack/retry mechanics
	assert.equal(msg.isAcked, true, "Message should be acknowledged on success");
	assert.equal(msg.isRetried, false, "Message should not be retried on success");

	// Assert outbound webhook dispatch
	assert.equal(globalThis.__mockWebhooks.length, 1);
	assert.equal(globalThis.__mockWebhooks[0].event, "message.outbound");
});

test("2. Transient failure on attempt 1: sending -> queued, queue retry requested", async () => {
	const env = {};
	globalThis.__mockSendThroughProvider = async () => {
		throw new Error("429 Too many requests");
	};

	const msg = createQueueMessage("job-123", "msg-123", 1);
	await assert.rejects(async () => {
		await runQueueConsumer(env, msg);
	}, /429 Too many requests/);

	// Assert states: job was claimed (sending) and safely restored to queued
	assert.equal(dbState.job.status, "queued");
	assert.match(dbState.job.error, /Attempt 1\/3 failed, retrying/);
	assert.equal(dbState.message.status, "queued");

	// Assert queue retry requested with 10s delay
	assert.equal(msg.isAcked, false, "Message should not be acked on transient failure");
	assert.equal(msg.isRetried, true, "Queue retry should be requested");
	assert.deepEqual(msg.retryOptions, { delaySeconds: 10 });

	// Assert no failure webhook dispatched during retryable state
	assert.equal(globalThis.__mockWebhooks.length, 0);
});

test("3. Transient failure on attempt 2: sending -> queued, queue retry requested", async () => {
	const env = {};
	globalThis.__mockSendThroughProvider = async () => {
		throw new Error("503 Service Unavailable");
	};

	const msg = createQueueMessage("job-123", "msg-123", 2);
	await assert.rejects(async () => {
		await runQueueConsumer(env, msg);
	}, /503 Service Unavailable/);

	assert.equal(dbState.job.status, "queued");
	assert.match(dbState.job.error, /Attempt 2\/3 failed, retrying/);
	assert.equal(dbState.message.status, "queued");

	assert.equal(msg.isAcked, false);
	assert.equal(msg.isRetried, true);
	assert.deepEqual(msg.retryOptions, { delaySeconds: 10 });
	assert.equal(globalThis.__mockWebhooks.length, 0);
});

test("4. Transient failure on attempt 3: sending -> failed, failure webhook dispatched, cleanly acknowledged", async () => {
	const env = {};
	globalThis.__mockSendThroughProvider = async () => {
		throw new Error("504 Gateway Timeout");
	};

	const msg = createQueueMessage("job-123", "msg-123", 3);
	// On attempt 3 exhaustion, error is suppressed so consumer acknowledges cleanly
	await runQueueConsumer(env, msg);

	// Assert states: marked failed
	assert.equal(dbState.job.status, "failed");
	assert.match(dbState.job.error, /Exhausted after 3 attempt\(s\)/);
	assert.equal(dbState.message.status, "failed");

	// Queue message acknowledged without further retry
	assert.equal(msg.isAcked, true, "Exhausted failure must be acknowledged");
	assert.equal(msg.isRetried, false, "No further retry should be requested after exhaustion");

	// Failure webhook dispatched
	assert.equal(globalThis.__mockWebhooks.length, 1);
	assert.equal(globalThis.__mockWebhooks[0].event, "message.failed");
	assert.equal(globalThis.__mockWebhooks[0].payload.messageId, "msg-123");
});

test("5. Permanent failure: sending -> failed without unnecessary further delivery", async () => {
	const env = {};
	globalThis.__mockSendThroughProvider = async () => {
		throw new Error("Invalid recipient email address");
	};

	const msg = createQueueMessage("job-123", "msg-123", 1);
	await runQueueConsumer(env, msg);

	// Assert states: permanently failed on attempt 1
	assert.equal(dbState.job.status, "failed");
	assert.match(dbState.job.error, /Permanent error/);
	assert.equal(dbState.message.status, "failed");

	// Queue message acknowledged immediately on attempt 1 without redundant delivery
	assert.equal(msg.isAcked, true, "Permanent error must be acknowledged immediately");
	assert.equal(msg.isRetried, false, "No queue retry should be requested on permanent error");

	// Failure webhook dispatched
	assert.equal(globalThis.__mockWebhooks.length, 1);
	assert.equal(globalThis.__mockWebhooks[0].event, "message.failed");
});

test("6. Ambiguous Resend response: retry with the same job ID and idempotency key", async () => {
	const env = {};
	const capturedIdempotencyKeys = [];

	// Attempt 1: Provider receives idempotency key, then connection drops (fetch failed)
	globalThis.__mockSendThroughProvider = async (_env, _config, _msg, idempotencyKey) => {
		capturedIdempotencyKeys.push(idempotencyKey);
		throw new Error("fetch failed");
	};

	const msg1 = createQueueMessage("job-123", "msg-123", 1);
	await assert.rejects(async () => {
		await runQueueConsumer(env, msg1);
	}, /fetch failed/);

	assert.equal(dbState.job.status, "queued");
	assert.equal(msg1.isRetried, true);

	// Attempt 2: Queue redelivers; Resend is called with the exact same idempotency key
	globalThis.__mockSendThroughProvider = async (_env, _config, _msg, idempotencyKey) => {
		capturedIdempotencyKeys.push(idempotencyKey);
		return { messageId: "<resend-deduped-msg-id>" };
	};

	const msg2 = createQueueMessage("job-123", "msg-123", 2);
	await runQueueConsumer(env, msg2);

	assert.equal(dbState.job.status, "sent");
	assert.equal(msg2.isAcked, true);

	// Verify idempotency keys across both attempts
	assert.equal(capturedIdempotencyKeys.length, 2);
	assert.equal(capturedIdempotencyKeys[0], "job-123");
	assert.equal(capturedIdempotencyKeys[1], "job-123");
	assert.equal(capturedIdempotencyKeys[0], capturedIdempotencyKeys[1], "Idempotency key must remain strictly identical across retries");
});
