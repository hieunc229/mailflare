import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { streamText } from "ai";
import { z } from "zod";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-workers-ai-stream-bundle-"));
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { getAgentModel } from "./src/lib/agent/model.ts";
		`,
		resolveDir: root,
		sourcefile: "workers-ai-stream-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": "next/headers.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});

const { getAgentModel } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

function createMockDb() {
	return {
		prepare() {
			return {
				bind() {
					return {
						all: async () => ({ results: [] }),
						raw: async () => [],
					};
				},
				all: async () => ({ results: [] }),
				raw: async () => [],
			};
		},
	};
}

function createSseStream(events) {
	return new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			for (const event of events) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			}
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
}

test("Workers AI dual-format SSE stream produces deduplicated text", async () => {
	const binding = {
		run: async () => createSseStream([
			{ response: "OK", choices: [{ index: 0, delta: { content: "OK" } }] },
			{ response: ".", choices: [{ index: 0, delta: { content: "." }, finish_reason: "stop" }] },
		]),
	};
	const agent = await getAgentModel({ DB: createMockDb(), AI: binding });
	assert.ok(agent?.model);
	const result = streamText({ model: agent.model, prompt: "say OK" });
	assert.equal(await result.text, "OK.");
});

test("Workers AI native-only stream emits text once", async () => {
	const binding = {
		run: async () => createSseStream([
			{ response: "OK" },
			{ response: ".", finish_reason: "stop" },
		]),
	};
	const agent = await getAgentModel({ DB: createMockDb(), AI: binding });
	assert.ok(agent?.model);
	const result = streamText({ model: agent.model, prompt: "say OK" });
	assert.equal(await result.text, "OK.");
});

test("Workers AI OpenAI-only stream emits text once", async () => {
	const binding = {
		run: async () => createSseStream([
			{ choices: [{ index: 0, delta: { content: "OK" } }] },
			{ choices: [{ index: 0, delta: { content: "." }, finish_reason: "stop" }] },
		]),
	};
	const agent = await getAgentModel({ DB: createMockDb(), AI: binding });
	assert.ok(agent?.model);
	const result = streamText({ model: agent.model, prompt: "say OK" });
	assert.equal(await result.text, "OK.");
});

test("Workers AI stream preserves legitimately repeated prose across events", async () => {
	const binding = {
		run: async () => createSseStream([
			{ response: "ha", choices: [{ index: 0, delta: { content: "ha" } }] },
			{ response: "ha", choices: [{ index: 0, delta: { content: "ha" }, finish_reason: "stop" }] },
		]),
	};
	const agent = await getAgentModel({ DB: createMockDb(), AI: binding });
	assert.ok(agent?.model);
	const result = streamText({ model: agent.model, prompt: "laugh" });
	assert.equal(await result.text, "haha");
});

test("Workers AI dual-format stream emits exactly one tool call with parsed arguments", async () => {
	const toolCall = [{ index: 0, id: "call_lookup", type: "function", function: { name: "lookup", arguments: JSON.stringify({ city: "Hanoi" }) } }];
	const binding = {
		run: async () => createSseStream([
			{ tool_calls: toolCall, choices: [{ index: 0, delta: { tool_calls: toolCall } }] },
		]),
	};
	const agent = await getAgentModel({ DB: createMockDb(), AI: binding });
	assert.ok(agent?.model);
	const result = streamText({
		model: agent.model,
		tools: {
			lookup: {
				description: "lookup info",
				parameters: z.object({ city: z.string() }),
				execute: async (args) => args,
			},
		},
		prompt: "lookup Hanoi",
	});
	const calls = await result.toolCalls;
	assert.equal(calls.length, 1);
	assert.equal(calls[0].toolName, "lookup");
	assert.deepEqual(calls[0].input, { city: "Hanoi" });
});

test("Workers AI stream handles events split across chunk boundaries", async () => {
	const payload = `data: ${JSON.stringify({ response: "OK", choices: [{ index: 0, delta: { content: "OK" } }] })}\n\ndata: [DONE]\n\n`;
	const encoder = new TextEncoder();
	const bytes = encoder.encode(payload);
	const splitAt = 12;
	const binding = {
		run: async () => new ReadableStream({
			start(controller) {
				controller.enqueue(bytes.subarray(0, splitAt));
				controller.enqueue(bytes.subarray(splitAt));
				controller.close();
			},
		}),
	};
	const agent = await getAgentModel({ DB: createMockDb(), AI: binding });
	assert.ok(agent?.model);
	const result = streamText({ model: agent.model, prompt: "say OK" });
	assert.equal(await result.text, "OK");
});
