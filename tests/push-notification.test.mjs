import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-push-notification-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: { push: join(root, "src/lib/push/server.ts") },
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	alias: { "@": join(root, "src") },
	packages: "external",
	logLevel: "silent",
});

const { buildNewMessagePushContent } = await import(pathToFileURL(join(outDir, "push.mjs")).href);

const payload = {
	type: "new_message",
	messageId: "msg_123",
	mailboxId: "mbx_123",
	from: "alerts@example.test",
	fromName: "Example",
	subject: "Your verification code",
};

test("Web Push shows the subject and the sender", () => {
	const content = buildNewMessagePushContent(payload);
	assert.equal(content.title, "Your verification code");
	assert.equal(content.body, "From Example <alerts@example.test>");
	assert.equal(content.tag, "msg_123");
	assert.equal(content.url, "/inbox/msg_123");
});

test("Web Push names the sender once and always shows the bare address", () => {
	const full = buildNewMessagePushContent({ ...payload, from: '"Example" <alerts@example.test>', fromName: "Example" });
	assert.equal(full.body, "From Example <alerts@example.test>");
	const renamed = buildNewMessagePushContent({ ...payload, from: '"Header Name" <alerts@example.test>', fromName: "Manual Name" });
	assert.equal(renamed.body, "From Manual Name <alerts@example.test>");
	const unnamed = buildNewMessagePushContent({ ...payload, from: '"Header Name" <alerts@example.test>', fromName: null });
	assert.equal(unnamed.body, "From alerts@example.test");
});
