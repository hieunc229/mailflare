import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zodSchema } from "ai";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-schema-bundle-"));
await build({
	stdin: {
		contents: `
			export { emailToolSchemas } from "./src/lib/agent/tools.ts";
			export { calendarToolSchemas } from "./src/lib/calendar/tools.ts";
		`,
		resolveDir: root,
		sourcefile: "agent-schema-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const { emailToolSchemas, calendarToolSchemas } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

// streamText sends zodSchema().jsonSchema (draft-07). MCP registerTool sends ~standard.jsonSchema.input (draft-2020-12).
const LOOKAROUND = /\(\?(?:[=!]|<[=!])/;

function providerSchemas(schema) {
	return [
		zodSchema(schema).jsonSchema,
		schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
	];
}

function patterns(schema, found = []) {
	if (!schema || typeof schema !== "object") return found;
	if (typeof schema.pattern === "string") found.push(schema.pattern);
	for (const value of Object.values(schema)) {
		if (Array.isArray(value)) value.forEach((item) => patterns(item, found));
		else patterns(value, found);
	}
	return found;
}

const toolSchemas = { ...emailToolSchemas, ...calendarToolSchemas };

test("model-facing email and calendar tool schemas contain no regex lookaround", () => {
	const offenders = [];
	for (const [name, schema] of Object.entries(toolSchemas)) {
		for (const json of providerSchemas(schema)) {
			for (const pattern of patterns(json)) {
				if (LOOKAROUND.test(pattern)) offenders.push(`${name}: ${pattern}`);
			}
		}
	}
	assert.deepEqual(offenders, []);
});

test("draft and calendar execution still validate email addresses", () => {
	const draft = { subject: "Hi", body: "Hello" };
	assert.equal(emailToolSchemas.draft_email.safeParse({ ...draft, to: "not-an-email" }).success, false);
	assert.equal(emailToolSchemas.draft_email.safeParse({ ...draft, to: "a..b@example.com" }).success, false);
	assert.equal(emailToolSchemas.draft_email.safeParse({ ...draft, to: "owner@example.com" }).success, true);

	const event = { title: "Meet", startsAt: "2026-10-12T15:00:00.000Z", endsAt: "2026-10-12T16:00:00.000Z" };
	assert.equal(calendarToolSchemas.create_event.safeParse({ ...event, attendees: ["not-an-email"] }).success, false);
	assert.equal(calendarToolSchemas.create_event.safeParse({ ...event, attendees: ["a..b@example.com"] }).success, false);
	assert.equal(calendarToolSchemas.create_event.safeParse({ ...event, attendees: ["owner@example.com"] }).success, true);
	assert.equal(calendarToolSchemas.update_events.safeParse({ updates: [{ eventId: "evt-1", attendees: ["not-an-email"] }] }).success, false);
	assert.equal(calendarToolSchemas.update_events.safeParse({ updates: [{ eventId: "evt-1", attendees: ["owner@example.com"] }] }).success, true);
});
