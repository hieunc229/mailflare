import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-auto-reply-order-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/email/auto-reply.ts")],
	outfile: join(directory, "auto-reply.mjs"),
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
			const mocks = {
				"@/db": `export function getDb() { return globalThis.__arDb; }`,
				"@/lib/email/routing": `export async function resolveInboundAddress() { globalThis.__arResolved += 1; return null; }`,
				"@/lib/email/send": `export async function sendEmail() { globalThis.__arSent += 1; return {}; }`,
			};
			builder.onResolve({ filter: /^@\/(db|lib\/email\/routing|lib\/email\/send)$/ }, ({ path }) => ({ path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ loader: "js", contents: mocks[path] }));
		},
	}],
});
const app = await import(pathToFileURL(join(directory, "auto-reply.mjs")).href);

function fakeDb(mailbox) {
	const chain = (rows) => {
		const node = { then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject) };
		for (const method of ["from", "where", "limit"]) node[method] = () => node;
		return node;
	};
	return { select: () => chain(mailbox ? [mailbox] : []) };
}
const input = { mailboxId: "box", userId: "u1", deliveredAddress: "me@one.test", fromAddress: "friend@x.test", incomingMessageId: "<a@x.test>", headers: {} };

test("a mailbox with auto-reply off does not resolve the sender", async () => {
	globalThis.__arDb = fakeDb({ autoReplyEnabled: false, autoReplySubject: "", autoReplyBody: "away", displayName: null });
	globalThis.__arResolved = 0;
	await app.sendMailboxAutoReply({}, input);
	assert.equal(globalThis.__arResolved, 0);
});

test("a mailbox with auto-reply on still resolves the sender before replying", async () => {
	globalThis.__arDb = fakeDb({ autoReplyEnabled: true, autoReplySubject: "", autoReplyBody: "away", displayName: null });
	globalThis.__arResolved = 0;
	await assert.doesNotReject(app.sendMailboxAutoReply({}, input).catch((error) => { if (globalThis.__arResolved === 0) throw error; }));
	assert.equal(globalThis.__arResolved, 1);
});
