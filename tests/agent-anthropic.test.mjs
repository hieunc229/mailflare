import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-anthropic-"));
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

// Answers like the Messages API: a thinking block (empty, as by default) before a tool call, then text.
async function fixture(t, model) {
	globalThis.testAgentProvider = {
		provider: "compatible", preset: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "test-api-key",
		model, models: [model], rates: {}, source: "saved",
	};
	t.after(() => { delete globalThis.testAgentProvider; });
	const requests = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		const body = JSON.parse(init.body);
		requests.push({ url: String(url), headers: new Headers(init.headers), body });
		const callTool = body.tools?.length && !body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_result"));
		const content = callTool
			? [{ type: "thinking", thinking: "", signature: "sig-1" }, { type: "tool_use", id: "toolu_1", name: "list_emails", input: { limit: 2 } }]
			: [{ type: "text", text: "OK" }];
		return Response.json({ id: `msg_${requests.length}`, type: "message", role: "assistant", model, content, stop_reason: callTool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
	});
	return { model: (await getAgentModel({})).model, requests };
}

const listEmails = tool({ description: "List emails", inputSchema: z.object({ limit: z.number() }), execute: async () => ({ emails: [] }) });

test("Claude 5.x runs at low effort through the Messages API", async t => {
	const { model, requests } = await fixture(t, "claude-sonnet-5-5");
	const result = await generateText({ model, prompt: "List my email", maxOutputTokens: 1200, tools: { list_emails: listEmails }, stopWhen: stepCountIs(3) });
	assert.equal(result.text, "OK");
	assert.equal(requests.length, 2);
	for (const { url, headers, body } of requests) {
		assert.equal(url, "https://api.anthropic.com/v1/messages");
		assert.equal(headers.get("x-api-key"), "test-api-key");
		assert.ok(headers.get("anthropic-version"));
		assert.equal(body.model, "claude-sonnet-5-5");
		assert.equal(body.max_tokens, 1200);
		assert.equal(body.output_config?.effort, "low");
		assert.equal(Object.hasOwn(body, "temperature"), false);
		assert.equal(Object.hasOwn(body, "thinking"), false);
	}
	// The thinking block goes back unchanged before its tool call.
	const replayed = requests[1].body.messages.find(message => message.role === "assistant").content.map(block => block.type);
	assert.deepEqual(replayed, ["thinking", "tool_use"]);
});

for (const modelId of ["claude-opus-4-8", "claude-sonnet-4-5", "claude-haiku-4-5"]) {
	test(`${modelId} keeps the API's default effort`, async t => {
		const { model, requests } = await fixture(t, modelId);
		assert.equal((await generateText({ model, prompt: "Say OK", maxOutputTokens: 900 })).text, "OK");
		assert.equal(requests[0].body.max_tokens, 900);
		assert.equal(Object.hasOwn(requests[0].body, "output_config"), false);
	});
}
