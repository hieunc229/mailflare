import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { generateText, stepCountIs, streamText } from "ai";
import { z } from "zod";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-openai-parameters-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/agent/model.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	logLevel: "silent",
	plugins: [{
		name: "provider-config",
		setup(builder) {
			builder.onLoad({ filter: /[\\/]agent[\\/]provider\.ts$/ }, () => ({
				contents: "export async function getAgentProviderConfig() { return globalThis.testAgentProvider; }",
				loader: "ts",
			}));
		},
	}],
});
const { getAgentModel } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t, model, baseUrl = "https://api.openai.com/v1", preset = "openai") {
	globalThis.testAgentProvider = {
		provider: "compatible", preset, baseUrl, apiKey: "test-api-key",
		model, models: [model], rates: {}, source: "saved",
	};
	t.after(() => { delete globalThis.testAgentProvider; });
	const requests = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		const body = JSON.parse(init.body);
		requests.push({ url: String(url), body });
		// Match the real GPT-6 Chat Completions constraint instead of accepting
		// a request the production API would reject before streaming any output.
		if (String(url) === "https://api.openai.com/v1/chat/completions" && model === "gpt-6-luna" && body.tools?.length && body.reasoning_effort !== "none") {
			return Response.json({ error: { message: "Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions.", type: "invalid_request_error" } }, { status: 400 });
		}
		if (String(url).endsWith("/responses")) {
			const callTool = body.tools?.length && !body.input.some(item => item.type === "function_call_output");
			const item = callTool
				? { type: "function_call", id: "fc-1", call_id: "call-1", name: "list_emails", arguments: '{"limit":2}', status: "completed" }
				: { type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
			const response = { id: "resp-1", created_at: 1, model, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
			if (!body.stream) return Response.json(response);
			const events = [
				{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
				{ type: "response.output_item.added", output_index: 0, item: callTool ? { ...item, arguments: "" } : { ...item, status: "in_progress", content: [] } },
				callTool
					? { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments }
					: { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "OK" },
				{ type: "response.output_item.done", output_index: 0, item },
				{ type: "response.completed", response },
			];
			return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
		}
		const functionCall = { id: "call-1", type: "function", function: { name: "list_emails", arguments: '{"limit":2}' } };
		const toolCalls = body.tools ? [functionCall] : undefined;
		if (body.stream) {
			const chunk = { id: "test", object: "chat.completion.chunk", created: 1, model,
				choices: [{ index: 0, delta: toolCalls ? { tool_calls: [{ ...functionCall, index: 0 }] } : { content: "OK" }, finish_reason: toolCalls ? "tool_calls" : "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
		}
		return Response.json({ id: "test", object: "chat.completion", created: 1, model,
			choices: [{ index: 0, message: { role: "assistant", content: "OK", tool_calls: toolCalls }, finish_reason: toolCalls ? "tool_calls" : "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
	});
	return { model: (await getAgentModel({})).model, requests };
}

for (const [modelId, parameter] of [
	["gpt-6-luna", "max_output_tokens"],
	["gpt-6-sol", "max_output_tokens"],
	["gpt-5", "max_output_tokens"],
	["ft:gpt-5-2025-08-07:org:custom:id", "max_output_tokens"],
	["o3-mini", "max_completion_tokens"],
	["o1", "max_completion_tokens"],
	["gpt-4o-mini", "max_tokens"],
	["gpt-3.5-turbo", "max_tokens"],
	["ft:gpt-4o-mini-2024-07-18:org:custom:id", "max_tokens"],
]) {
	test(`official ${modelId} uses ${parameter} for chat and drafts`, async t => {
		const { model, requests } = await fixture(t, modelId);
		assert.equal((await generateText({ model, prompt: "Say OK", maxOutputTokens: 900 })).text, "OK");
		assert.equal(await streamText({ model, prompt: "Say OK", maxOutputTokens: 1200 }).text, "OK");
		assert.equal(requests.length, 2);
		for (const [index, { url, body }] of requests.entries()) {
			assert.equal(url, `https://api.openai.com/v1/${parameter === "max_output_tokens" ? "responses" : "chat/completions"}`);
			assert.equal(body.model, modelId);
			assert.equal(body[parameter], index === 0 ? 900 : 1200);
			assert.equal(Object.hasOwn(body, parameter === "max_tokens" ? "max_completion_tokens" : "max_tokens"), false);
			if (parameter === "max_output_tokens") {
				assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
				assert.equal(body.store, false);
			}
		}
	});
}

test("custom official endpoint and selected model use OpenAI parameters", async t => {
	const { requests } = await fixture(t, "gpt-4o-mini", "https://api.openai.com/v1/", "custom");
	globalThis.testAgentProvider.models.push("gpt-6-luna");
	const selected = await getAgentModel({}, "gpt-6-luna");
	await generateText({ model: selected.model, prompt: "Say OK", maxOutputTokens: 900 });
	assert.equal(requests[0].body.model, "gpt-6-luna");
	assert.equal(requests[0].body.max_output_tokens, 900);
	assert.equal(Object.hasOwn(requests[0].body, "max_tokens"), false);
});

for (const [preset, endpoint, modelId] of [
	["openrouter", "https://openrouter.ai/api/v1", "openai/gpt-6-luna"],
	["groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"],
	["custom", "https://compatible.example/v1", "gpt-6-luna"],
	["custom", "https://api.openai.com.example/v1", "gpt-6-luna"],
]) {
	test(`${preset} ${endpoint} retains compatible request parameters`, async t => {
		const { model, requests } = await fixture(t, modelId, endpoint, preset);
		assert.equal(await streamText({ model, prompt: "Say OK", maxOutputTokens: 1200 }).text, "OK");
		assert.equal(requests[0].url, `${endpoint}/chat/completions`);
		assert.equal(requests[0].body.max_tokens, 1200);
		assert.equal(Object.hasOwn(requests[0].body, "max_completion_tokens"), false);
	});
}

test("OpenAI streaming preserves assistant tool calls", async t => {
	const { model, requests } = await fixture(t, "gpt-6-luna");
	const result = streamText({ model, prompt: "List recent emails", maxOutputTokens: 1200,
		tools: { list_emails: { description: "List emails", inputSchema: z.object({ limit: z.number() }) } } });
	const calls = await result.toolCalls;
	assert.equal(calls.length, 1);
	assert.equal(calls[0].toolName, "list_emails");
	assert.deepEqual(calls[0].input, { limit: 2 });
	assert.equal(requests[0].url, "https://api.openai.com/v1/responses");
	assert.equal(requests[0].body.tools[0].name, "list_emails");
	assert.equal(requests[0].body.max_output_tokens, 1200);
	assert.equal(requests[0].body.store, false);
});

test("Responses continues after a tool result without server-stored conversation state", async t => {
	const { model, requests } = await fixture(t, "gpt-6-luna");
	const result = streamText({ model, prompt: "Use the tool then say OK", maxOutputTokens: 1200, stopWhen: stepCountIs(2),
		tools: { list_emails: { description: "List emails", inputSchema: z.object({ limit: z.number() }), execute: async () => ({ messages: [] }) } } });
	assert.equal(await result.text, "OK");
	assert.equal(requests.length, 2);
	assert.ok(requests[1].body.input.some(item => item.type === "function_call_output" && item.call_id === "call-1"));
	assert.ok(requests.every(({ body }) => body.store === false && !body.previous_response_id));
});
