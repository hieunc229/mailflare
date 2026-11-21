import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-imap-folder-names-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const mockSockets = join(outDir, "sockets.mjs");
writeFileSync(mockSockets, "export const connect = (...args) => globalThis.__imapConnect(...args);\n");

await build({
	stdin: {
		contents: `export { fetchImapMessages, listImapFolders } from "./src/lib/import/imap.ts";
export { decodeImapMailboxName, encodeImapMailboxName } from "./src/lib/import/imap-utils.ts";`,
		resolveDir: root,
		sourcefile: "imap-folder-names-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
	plugins: [
		{
			name: "cloudflare-sockets",
			setup(pluginBuild) {
				pluginBuild.onLoad({ filter: /src[\\/]lib[\\/]import[\\/]imap\.ts$/ }, async (args) => {
					const source = await readFile(args.path, "utf8");
					return {
						contents: source.replace('"cloudflare:sockets"', JSON.stringify(pathToFileURL(mockSockets).href)),
						loader: "ts",
						resolveDir: dirname(args.path),
					};
				});
			},
		},
	],
});

const { fetchImapMessages, listImapFolders, decodeImapMailboxName, encodeImapMailboxName } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

// A server that answers LIST with fixed lines and records every command it gets.
function startServer(listReply) {
	const commands = [];
	globalThis.__imapConnect = () => {
		let controller;
		const readable = new ReadableStream({ start(value) { controller = value; } });
		const send = (data) => controller.enqueue(new Uint8Array(Buffer.from(data)));
		send("* OK ready\r\n");
		const writable = new WritableStream({
			write(chunk) {
				for (const line of Buffer.from(chunk).toString().split("\r\n").filter(Boolean)) {
					commands.push(line);
					const [tag, ...rest] = line.split(" ");
					const command = rest.join(" ");
					if (command.startsWith("LIST")) send(listReply);
					if (command.startsWith("UID SEARCH")) send("* SEARCH\r\n");
					send(`${tag} OK done\r\n`);
				}
			},
		});
		return { readable, writable };
	};
	return commands;
}

const account = { host: "imap.example.com", port: 993, secure: true, username: "u", password: "p" };

test("folder names are decoded from modified UTF-7 and read from literals", async () => {
	startServer([
		'* LIST (\\HasNoChildren) "/" INBOX\r\n',
		'* LIST (\\HasNoChildren) "/" "G&APY-nderilmi&AV8- &- Ar&AV8-iv"\r\n',
		'* LIST (\\HasNoChildren) "/" "[Gmail]/Entw&APw-rfe"\r\n',
		'* LIST (\\HasNoChildren) "/" {12}\r\nSay "hi" now\r\n',
		'* LIST (\\HasNoChildren) "/" "&ZeVnLIqe-"\r\n',
	].join(""));
	assert.deepEqual(await listImapFolders(account), ["INBOX", "Gönderilmiş & Arşiv", "[Gmail]/Entwürfe", 'Say "hi" now', "日本語"]);
});

test("a decoded folder name is encoded again when it is opened", async () => {
	const commands = startServer("");
	await fetchImapMessages({ ...account, folder: "Gönderilmiş & Arşiv", limit: 10, offset: 0 });
	assert.ok(commands.some((line) => line.endsWith('EXAMINE "G&APY-nderilmi&AV8- &- Ar&AV8-iv"')), commands.join("\n"));
});

test("modified UTF-7 round trips, including characters outside the BMP", () => {
	for (const name of ["INBOX", "R&D", "Entwürfe/2026", "日本語", "Notes 📝", "~/+,"]) assert.equal(decodeImapMailboxName(encodeImapMailboxName(name)), name);
	assert.equal(encodeImapMailboxName("日本語"), "&ZeVnLIqe-");
	assert.equal(decodeImapMailboxName("&Jjo-!"), "☺!");
});
