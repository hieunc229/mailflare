import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-imap-fetch-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const mockSockets = join(outDir, "sockets.mjs");
writeFileSync(mockSockets, "export const connect = (...args) => globalThis.__imapConnect(...args);\n");

await build({
	stdin: {
		contents: `export { fetchImapMessages } from "./src/lib/import/imap.ts";
export { parseFetchFlags } from "./src/lib/import/imap-utils.ts";`,
		resolveDir: root,
		sourcefile: "imap-fetch-test-entry.js",
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

const { fetchImapMessages, parseFetchFlags } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const CHUNK = 16 * 1024;

function startServer(messages) {
	const commands = [];
	globalThis.__imapConnect = () => {
		let controller;
		const readable = new ReadableStream({
			start(value) {
				controller = value;
			},
		});
		const send = (data) => {
			const bytes = typeof data === "string" ? Buffer.from(data) : data;
			for (let offset = 0; offset < bytes.length; offset += CHUNK) {
				controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + CHUNK)));
			}
		};
		send("* OK ready\r\n");
		const writable = new WritableStream({
			write(chunk) {
				const line = Buffer.from(chunk).toString().trim();
				commands.push(line);
				const [tag, ...rest] = line.split(" ");
				const command = rest.join(" ");
				if (command.startsWith("UID SEARCH")) send(`* SEARCH ${Object.keys(messages).join(" ")}\r\n`);
				const fetch = command.match(/^UID FETCH (\d+)/);
				if (fetch) {
					const { body, flags, flagsAfterBody } = messages[fetch[1]];
					const head = `* ${fetch[1]} FETCH (UID ${fetch[1]} `;
					send(
						flagsAfterBody
							? Buffer.concat([Buffer.from(`${head}BODY[] {${body.length}}\r\n`), body, Buffer.from(` FLAGS (${flags}))\r\n`)])
							: Buffer.concat([Buffer.from(`${head}FLAGS (${flags}) BODY[] {${body.length}}\r\n`), body, Buffer.from(")\r\n")]),
					);
				}
				send(`${tag} OK done\r\n`);
			},
		});
		return { readable, writable };
	};
	return commands;
}

const baseInput = { host: "imap.example.com", port: 993, secure: true, username: "u", password: "p", folder: "INBOX", limit: 100, offset: 0 };

function message(size, fill) {
	const body = Buffer.alloc(size, fill);
	for (let index = 76; index < size - 1; index += 78) {
		body[index] = 13;
		body[index + 1] = 10;
	}
	return body;
}

test("parseFetchFlags reads flags from either side of the literal", () => {
	assert.deepEqual(parseFetchFlags("* 1 FETCH (UID 1 FLAGS (\\Seen \\Flagged) BODY[] {10}"), ["\\SEEN", "\\FLAGGED"]);
	assert.deepEqual(parseFetchFlags(" FLAGS ())"), []);
	assert.equal(parseFetchFlags("* 1 FETCH (UID 1 BODY[] {10}"), null);
});

test("imports keep read and starred state without marking the source read", async () => {
	const commands = startServer({
		1: { body: message(200, 65), flags: "\\Seen \\Flagged" },
		2: { body: message(200, 66), flags: "" },
		3: { body: message(200, 67), flags: "\\Seen", flagsAfterBody: true },
	});
	const result = await fetchImapMessages(baseInput);
	assert.deepEqual(
		result.messages.map((item) => [item.filename, item.read, item.starred]),
		[
			["INBOX-1.eml", true, true],
			["INBOX-2.eml", false, false],
			["INBOX-3.eml", true, false],
		],
	);
	assert.ok(commands.some((line) => line.includes("EXAMINE")));
	assert.ok(!commands.some((line) => / SELECT /.test(line)));
	assert.ok(commands.filter((line) => line.includes("UID FETCH")).every((line) => line.includes("BODY.PEEK[]")));
});

test("large messages arrive intact and a batch stops at the byte budget", async () => {
	const mb = 1024 * 1024;
	const bodies = { 1: message(8 * mb, 65), 2: message(8 * mb, 66), 3: message(8 * mb, 67), 4: message(2 * mb, 68), 5: message(8 * mb, 69) };
	startServer(Object.fromEntries(Object.entries(bodies).map(([uid, body]) => [uid, { body, flags: "" }])));

	const first = await fetchImapMessages(baseInput);
	assert.deepEqual(first.messages.map((item) => item.filename), ["INBOX-2.eml", "INBOX-3.eml", "INBOX-4.eml", "INBOX-5.eml"]);
	assert.equal(first.nextOffset, 4);
	for (const item of first.messages) {
		const uid = item.filename.match(/-(\d+)\.eml$/)[1];
		assert.ok(Buffer.from(item.raw).equals(bodies[uid]), `message ${uid} changed in transit`);
	}

	const second = await fetchImapMessages({ ...baseInput, offset: first.nextOffset });
	assert.deepEqual(second.messages.map((item) => item.filename), ["INBOX-1.eml"]);
	assert.equal(second.nextOffset, null);
});
