import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import nodemailer from "nodemailer";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-smtp-reject-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { startSmtpListener } from "./server/runtime/smtp.ts";
		`,
		resolveDir: root,
		sourcefile: "smtp-reject-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	plugins: [{
		name: "mocks",
		setup(builder) {
			// SPF/DKIM lookups would hit the network; the verdicts do not matter here.
			builder.onResolve({ filter: /^\.\/smtp-auth$/ }, () => ({ path: "smtp-auth", namespace: "mock" }));
			builder.onResolve({ filter: /^@\/lib\/licenses\/service$/ }, () => ({ path: "licenses", namespace: "mock" }));
			builder.onLoad({ filter: /^smtp-auth$/, namespace: "mock" }, () => ({ loader: "js", contents: "export async function verifySmtpAuthentication() { return undefined; }" }));
			builder.onLoad({ filter: /^licenses$/, namespace: "mock" }, () => ({ loader: "js", contents: "export async function getLicenseEntitlements() { return { canForwardEmail: true }; }" }));
		},
	}],
});
const { SqliteDatabase, applyMigrations, startSmtpListener } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("a recipient blocked by a reject rule is refused at RCPT TO and the others still get the message", async (t) => {
	t.mock.method(console, "log", () => {});
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'admin', 'one.test', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('me', 'admin', 'one', 'me', 1), ('blocked', 'admin', 'one', 'blocked', 1);
		INSERT INTO routing_rules (id, user_id, domain_id, scope, pattern, action, match_field, match_operator, match_value, reject_reason, enabled, priority, created_at)
			VALUES ('r', 'admin', 'one', 'domain', 'blocked@one.test', 'reject', 'recipient', 'exact', 'blocked@one.test', 'No mail for this address', 1, 10, 1);
	`);
	const queued = [];
	const env = {
		DB: database,
		BUCKET: { put: async () => {} },
		INBOUND_QUEUE: { send: async (payload) => { queued.push(payload.to); } },
	};
	const mailer = { sendRaw: async () => true };
	const server = startSmtpListener(env, mailer, { port: 0, host: "127.0.0.1", maxSize: 1e6, hostname: "mx.test", tls: null });
	t.after(() => server.close());
	if (!server.server.listening) await once(server.server, "listening");
	const transport = nodemailer.createTransport({ host: "127.0.0.1", port: server.server.address().port, secure: false, ignoreTLS: true });

	const info = await transport.sendMail({ from: "a@ext.test", to: ["me@one.test", "blocked@one.test"], subject: "hi", text: "body" });
	assert.deepEqual(info.accepted, ["me@one.test"]);
	assert.deepEqual(info.rejected, ["blocked@one.test"]);
	assert.match(info.rejectedErrors[0].response, /^550 No mail for this address/);
	assert.deepEqual(queued, ["me@one.test"]);
	const [rule] = database.db.prepare("SELECT match_count FROM routing_rules WHERE id = 'r'").all();
	assert.equal(rule.match_count, 1);

	// Every recipient blocked: nodemailer gives up before DATA.
	await assert.rejects(transport.sendMail({ from: "a@ext.test", to: "blocked@one.test", subject: "hi", text: "body" }), /No mail for this address/);
	assert.deepEqual(queued, ["me@one.test"]);
});
