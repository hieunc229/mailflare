import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import nodemailer from "nodemailer";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-smtp-forward-"));
after(() => rmSync(directory, { recursive: true, force: true }));

// Intake asks for one forward with the loop-guard marker, as a forward rule does.
const mocks = {
	"@/lib/email/intake": `export async function intakeIncomingMail(env, input, actions) {
		await actions.forward("other@one.test", { "X-Mailflare-Forwarded": "v1.marker" });
		return { action: "forward", forwardedTo: "other@one.test" };
	}`,
	"@/lib/email/inbound-attachments": "export async function inboundAttachmentLimitReasonFromRaw() { return null; }",
	"@/db": `export function getDb() { const q = { select: () => q, from: () => q, where: () => q, limit: async () => [{ id: "d" }] }; return q; }`,
	"@/db/schema": `export const domains = { id: "id", hostname: "hostname" };`,
	"./smtp-auth": "export async function verifySmtpAuthentication() { return undefined; }",
	"@/lib/email/routing": "export async function resolveInboundAddress() { return null; } export async function recordRuleMatch() {}",
};
await build({
	entryPoints: [join(root, "server/runtime/smtp.ts")],
	outfile: join(directory, "smtp.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
	plugins: [{
		name: "mocks",
		setup(builder) {
			builder.onResolve({ filter: /.*/ }, ({ path }) => (path in mocks ? { path, namespace: "mock" } : undefined));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: mocks[path], loader: "js" }));
		},
	}],
});
const { startSmtpListener, parseHeaders, prependHeaders } = await import(pathToFileURL(join(directory, "smtp.mjs")).href);

test("a message forwarded by the SMTP listener carries the loop-guard marker", async (t) => {
	t.mock.method(console, "log", () => {});
	const relayed = [];
	const mailer = { sendRaw: async (from, to, raw) => { relayed.push({ from, to, raw }); return true; } };
	const server = startSmtpListener({}, mailer, { port: 0, host: "127.0.0.1", maxSize: 1e6, hostname: "mx.test", tls: null });
	t.after(() => server.close());
	if (!server.server.listening) await once(server.server, "listening");
	const transport = nodemailer.createTransport({ host: "127.0.0.1", port: server.server.address().port, secure: false, ignoreTLS: true });
	await transport.sendMail({ from: "a@ext.test", to: "me@one.test", subject: "hi", text: "body" });

	assert.equal(relayed.length, 1);
	assert.equal(relayed[0].to, "other@one.test");
	// Intake reads the marker from this header map when the copy comes back in.
	const headers = parseHeaders(relayed[0].raw);
	assert.equal(headers["x-mailflare-forwarded"], "v1.marker");
	assert.equal(headers.subject, "hi");
	assert.match(relayed[0].raw.toString("latin1"), /\r\n\r\nbody/);
});

test("prependHeaders puts the headers on top and keeps them on one line", () => {
	const raw = Buffer.from("Subject: hi\r\n\r\nbody\r\n");
	assert.equal(prependHeaders(raw, {}), raw);
	assert.equal(
		prependHeaders(raw, { "X-Mailflare-Forwarded": "v1.a\r\nBcc: x@evil.test" }).toString("latin1"),
		"X-Mailflare-Forwarded: v1.a Bcc: x@evil.test\r\nSubject: hi\r\n\r\nbody\r\n",
	);
});
