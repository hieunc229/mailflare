import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-send-notice-bundle-"));
await build({
	stdin: {
		contents: `export { resolveSendNotice, splitSendTemplate } from "./src/components/compose/send-notice-utils.ts";
			export { resolveSendViewRoute } from "./src/components/messages/send-view-utils.ts";`,
		resolveDir: root,
		sourcefile: "send-notice-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { resolveSendNotice, splitSendTemplate, resolveSendViewRoute } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
rmSync(bundleDirectory, { recursive: true, force: true });

const now = Date.parse("2026-10-28T12:00:00.000Z");
const at = (offsetMs) => new Date(now + offsetMs).toISOString();

test("a delivered scheduled reader follows the message to Sent", () => {
	assert.equal(resolveSendViewRoute("/scheduled/msg_1", "msg_1", "sent"), "/sent/msg_1");
	for (const status of ["queued", "sending", "failed"]) {
		assert.equal(resolveSendViewRoute("/scheduled/msg_1", "msg_1", status), null);
	}
});

test("Undo closes only the cancelled message reader, preserving its folder", () => {
	assert.equal(resolveSendViewRoute("/scheduled/msg_1", "msg_1", "draft"), "/scheduled");
	assert.equal(resolveSendViewRoute("/sent/msg_1", "msg_1", "draft"), "/sent");
	for (const path of ["/scheduled", "/sent", "/scheduled/msg_2", "/sent/msg_2", "/inbox/msg_1"]) {
		assert.equal(resolveSendViewRoute(path, "msg_1", "draft"), null);
		assert.equal(resolveSendViewRoute(path, "msg_1", "sent"), null);
	}
	assert.equal(resolveSendViewRoute("/sent/msg_1", "msg_1", "sent"), null);
});

test("an undo window counts down from the duration the server reports", () => {
	assert.deepEqual(
		resolveSendNotice({ messageId: "msg_1", scheduled: true, undoSeconds: 15, undoRemainingMs: 14_200 }, now),
		{ kind: "undo", messageId: "msg_1", endAt: now + 14_200, durationMs: 14_200 },
	);
});

test("a missing remaining duration falls back to the configured undo window", () => {
	assert.deepEqual(
		resolveSendNotice({ messageId: "msg_1", scheduled: true, undoSeconds: 10 }, now),
		{ kind: "undo", messageId: "msg_1", endAt: now + 10_000, durationMs: 10_000 },
	);
});

test("a window with no time left waits for the queue's result", () => {
	for (const undoRemainingMs of [0, -1]) {
		assert.deepEqual(
			resolveSendNotice({ messageId: "msg_1", scheduled: true, undoSeconds: 5, undoRemainingMs }, now),
			{ kind: "sending", messageId: "msg_1" },
		);
	}
});

test("an explicit schedule carries its time for the cancel toast", () => {
	assert.deepEqual(
		resolveSendNotice({ messageId: "msg_2", scheduled: true, scheduledAt: at(86_400_000) }, now),
		{ kind: "scheduled", messageId: "msg_2", scheduledAt: at(86_400_000) },
	);
});

test("a schedule without a timestamp is still cancellable", () => {
	assert.deepEqual(
		resolveSendNotice({ messageId: "msg_2", scheduled: true }, now),
		{ kind: "scheduled", messageId: "msg_2", scheduledAt: null },
	);
});

test("an immediate send and a response without a message id have no action", () => {
	assert.deepEqual(resolveSendNotice({ messageId: "msg_3" }, now), { kind: "sent" });
	assert.deepEqual(resolveSendNotice({}, now), { kind: "sent" });
});

test("the countdown template splits the subject from the ticking seconds", () => {
	const parts = splitSendTemplate("Sending “{subject}” in {seconds}s", true);
	assert.equal(parts.before, "Sending “");
	assert.equal(parts.after, "” in ");
	assert.equal(parts.ticker?.(9), "9s");
	assert.equal(parts.ticker?.(0), "0s");
});

test("a template without seconds keeps the whole suffix after the subject", () => {
	assert.deepEqual(splitSendTemplate("Sending “{subject}”...", false), {
		before: "Sending “",
		after: "”...",
	});
	assert.deepEqual(splitSendTemplate("Sent “{subject}”", false), {
		before: "Sent “",
		after: "”",
	});
});

test("every locale preserves the linked subject and countdown placeholders", () => {
	const keys = ["compose.sendingIn", "compose.sendingSubject", "compose.sentSubject", "compose.undoSend", "compose.sendNow"];
	const en = JSON.parse(readFileSync(join(root, "src/lib/i18n/en.json"), "utf8"));
	const placeholders = (value) => [...value.matchAll(/\{\w+\}/g)].map(([token]) => token).sort();
	for (const file of readdirSync(join(root, "public/locales"))) {
		if (!file.endsWith(".json")) continue;
		const catalog = JSON.parse(readFileSync(join(root, "public/locales", file), "utf8"));
		for (const key of keys) {
			assert.ok(catalog[key]?.trim(), `${file}: ${key}`);
			assert.deepEqual(placeholders(catalog[key]), placeholders(en[key]), `${file}: ${key}`);
		}
		const template = catalog["compose.sendingIn"];
		assert.ok(template.indexOf("{subject}") < template.indexOf("{seconds}"), file);
		const parts = splitSendTemplate(template, true);
		assert.equal(parts.before + "SUBJECT" + parts.after + parts.ticker(7), template.replace("{subject}", "SUBJECT").replace("{seconds}", "7"), file);
	}
});
