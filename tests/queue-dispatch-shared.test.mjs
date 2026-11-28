import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("worker and vercel consumer share one dispatcher", () => {
	const worker = readFileSync("worker.ts", "utf8");
	const vercel = readFileSync("server/runtime/vercel-queue-consumer.ts", "utf8");
	assert.match(worker, /dispatchQueueMessage\(/);
	assert.match(vercel, /dispatchQueueMessage\(/);
	assert.doesNotMatch(vercel, /async function dispatch\(/);
});

test("vercel consumer logs a message dropped past the retry limit", () => {
	const vercel = readFileSync("server/runtime/vercel-queue-consumer.ts", "utf8");
	const start = vercel.indexOf("deliveryCount > QUEUE_MAX_RETRIES[queue] + 1");
	assert.ok(start > 0);
	const end = vercel.indexOf("return;", start);
	assert.match(vercel.slice(start, end), /console\.error\(/);
});
