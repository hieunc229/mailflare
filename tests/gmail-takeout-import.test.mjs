import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { mapGmailLabels, parseGmailLabels, runTakeoutImport, splitMbox } from "../src/lib/import/gmail-takeout-utils.ts";
import { listZipEntries, openZipEntry, readStreamChunks } from "../src/lib/import/zip-utils.ts";

const latin1 = (text) => Buffer.from(text, "latin1");

async function* chunked(text, size = text.length) {
	for (let index = 0; index < text.length; index += size) yield new Uint8Array(latin1(text.slice(index, index + size)));
}

async function collect(iterable) {
	const messages = [];
	for await (const raw of iterable) messages.push(Buffer.from(raw).toString("latin1"));
	return messages;
}

const mbox = [
	"From 1795843245834567890@xxx Thu Oct 22 10:11:12 +0000 2026\r\n",
	"X-Gmail-Labels: Inbox,Unread,\"Kunden, alt\"\r\n",
	"Subject: one\r\n",
	"\r\n",
	"Hello\r\n",
	">From the archive\r\n",
	"From is not a separator here\r\n",
	"\r\n",
	"From 1795843245834567891@xxx Thu Oct 22 10:12:12 +0000 2026\r\n",
	"X-Gmail-Labels: Archived,Starred,Newton/Doped\r\n",
	"Subject: caf\xe9\r\n",
	"\r\n",
	"8-bit body \xff\xfe\r\n",
].join("");

test("mbox messages are split on From_ lines and keep their bytes", async () => {
	const messages = await collect(splitMbox(chunked(mbox)));
	assert.equal(messages.length, 2);
	assert.ok(messages[0].startsWith("X-Gmail-Labels: Inbox"));
	assert.ok(messages[0].includes("\r\nFrom the archive\r\n"));
	assert.ok(messages[0].endsWith("From is not a separator here\r\n"));
	assert.ok(messages[1].endsWith("8-bit body \xff\xfe\r\n"));
});

test("splitting does not depend on where chunks end", async () => {
	assert.deepEqual(await collect(splitMbox(chunked(mbox, 7))), await collect(splitMbox(chunked(mbox))));
});

test("labels are parsed, including quoted, folded and encoded ones", () => {
	assert.deepEqual(parseGmailLabels(latin1('X-Gmail-Labels: Inbox,Unread,"Kunden, alt"\r\n\r\nbody')), ["Inbox", "Unread", "Kunden, alt"]);
	assert.deepEqual(parseGmailLabels(latin1("Subject: x\nX-Gmail-Labels: Sent,\n Projekte\n\nbody")), ["Sent", "Projekte"]);
	assert.deepEqual(parseGmailLabels(latin1("X-Gmail-Labels: =?UTF-8?Q?Entw=C3=BCrfe?=\r\n\r\n")), ["Entwürfe"]);
	assert.deepEqual(parseGmailLabels(latin1("Subject: none\r\n\r\nX-Gmail-Labels: Inbox")), []);
});

test("labels map to sections, folders and read state", () => {
	assert.deepEqual(mapGmailLabels(["Inbox", "Unread", "Newton"]), { destination: { type: "system", section: "inbox" }, read: false, starred: false });
	assert.deepEqual(mapGmailLabels(["Sent", "Inbox"]).destination, { type: "system", section: "sent" });
	assert.deepEqual(mapGmailLabels(["Papierkorb", "Inbox"]).destination, { type: "system", section: "trash" });
	assert.deepEqual(mapGmailLabels(["Archived", "Starred", "Important", "Newton/Doped"]), { destination: { type: "folder", name: "Newton/Doped" }, read: true, starred: true });
	assert.deepEqual(mapGmailLabels(["Category Promotions", "Opened"]).destination, { type: "system", section: "archived" });
	assert.deepEqual(mapGmailLabels(["Newton"], { folders: false }).destination, { type: "system", section: "archived" });
	const ignore = ["[Superhuman]/", "Save"];
	assert.deepEqual(mapGmailLabels(["[Superhuman]/AI/News", "Save", "Apple"], { ignore }).destination, { type: "folder", name: "Apple" });
	assert.deepEqual(mapGmailLabels(["[Superhuman]", "[Superhuman]/AI"], { ignore }).destination, { type: "system", section: "archived" });
});

function message(index, labels, body = "body") {
	return `From x@xxx Thu Oct 22 10:00:00 +0000 2026\r\nX-Gmail-Labels: ${labels}\r\nMessage-ID: <m${index}@example.com>\r\n\r\n${body}\r\n\r\n`;
}

test("import batches per destination, resolves folders once and reports progress", async () => {
	const text = [message(1, "Inbox"), message(2, "Kunden"), message(3, "Inbox,Unread"), message(4, "Spam"), message(5, "Kunden")].join("");
	const uploads = [];
	const folders = [];
	const summary = await runTakeoutImport(splitMbox(chunked(text)), {
		skipSpam: true,
		upload: async (destination, messages) => {
			uploads.push({ destination, files: messages.map((item) => [item.filename, item.read]) });
			return { status: 200, data: { imported: messages.length, skipped: 0, errors: [] } };
		},
		resolveFolder: async (name) => {
			folders.push(name);
			return "fld_1";
		},
	});
	assert.deepEqual(folders, ["Kunden"]);
	assert.deepEqual(uploads.sort((a, b) => a.destination.localeCompare(b.destination)), [
		{ destination: "folder:fld_1", files: [["takeout-2.eml", true], ["takeout-5.eml", true]] },
		{ destination: "system:inbox", files: [["takeout-1.eml", true], ["takeout-3.eml", false]] },
	]);
	assert.equal(summary.imported, 4);
	assert.equal(summary.ignored, 1);
	assert.equal(summary.committed, 5);
});

test("failing batches are split, a single bad message is skipped, startAt resumes", async () => {
	const text = [1, 2, 3, 4].map((index) => message(index, "Inbox", index === 3 ? "BAD" : "ok")).join("");
	const summary = await runTakeoutImport(splitMbox(chunked(text)), {
		startAt: 1,
		wait: async () => {},
		resolveFolder: async () => "x",
		upload: async (_destination, messages) => {
			const bad = messages.some((item) => Buffer.from(item.raw).toString().includes("BAD"));
			return bad ? { status: 413, data: { error: "Invalid import upload" } } : { status: 200, data: { imported: messages.length } };
		},
	});
	assert.equal(summary.read, 4);
	assert.equal(summary.imported, 2);
	assert.equal(summary.failed, 1);
	assert.match(summary.errors[0], /takeout-3\.eml/);
});

test("an aborted import stops and keeps the committed position", async () => {
	const controller = new AbortController();
	const text = [1, 2, 3].map((index) => message(index, "Inbox")).join("");
	const summary = await runTakeoutImport(splitMbox(chunked(text)), {
		signal: controller.signal,
		resolveFolder: async () => "x",
		upload: async () => ({ status: 200, data: { imported: 1 } }),
	});
	assert.equal(summary.aborted, false);
	controller.abort();
	const aborted = await runTakeoutImport(splitMbox(chunked(text)), { signal: controller.signal, resolveFolder: async () => "x", upload: async () => ({ status: 200, data: {} }) });
	assert.equal(aborted.aborted, true);
	assert.equal(aborted.committed, 0);
});

function buildZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const { name, data, method } of entries) {
		const nameBytes = Buffer.from(name);
		const payload = method === 8 ? deflateRawSync(data) : data;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		locals.push(local, nameBytes, payload);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBytes);
		offset += 30 + nameBytes.length + payload.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return new Blob([...locals, directory, end]);
}

test("zip entries are listed and deflated entries stream back intact", async () => {
	const zip = buildZip([
		{ name: "Takeout/archive_browser.html", data: Buffer.from("<html>"), method: 0 },
		{ name: "Takeout/Mail/All mail Including Spam and Trash.mbox", data: latin1(mbox), method: 8 },
	]);
	const entries = await listZipEntries(zip);
	assert.deepEqual(entries.map((entry) => entry.name), ["Takeout/archive_browser.html", "Takeout/Mail/All mail Including Spam and Trash.mbox"]);
	const messages = await collect(splitMbox(readStreamChunks(await openZipEntry(zip, entries[1]))));
	assert.equal(messages.length, 2);
	assert.ok(messages[1].endsWith("8-bit body \xff\xfe\r\n"));
});
