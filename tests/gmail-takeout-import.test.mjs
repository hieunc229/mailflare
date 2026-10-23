import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { mapGmailLabels, parseGmailLabels, readMboxMessages } from "../scripts/import-gmail-takeout.mjs";

async function collect(chunks) {
	const messages = [];
	for await (const raw of readMboxMessages(Readable.from(chunks.map((chunk) => Buffer.from(chunk, "latin1"))))) {
		messages.push(raw.toString("latin1"));
	}
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
	const messages = await collect([mbox]);
	assert.equal(messages.length, 2);
	assert.ok(messages[0].startsWith("X-Gmail-Labels: Inbox"));
	assert.ok(messages[0].includes("\r\nFrom the archive\r\n"));
	assert.ok(messages[0].includes("From is not a separator here"));
	assert.ok(messages[0].endsWith("From is not a separator here\r\n"));
	assert.ok(messages[1].endsWith("8-bit body \xff\xfe\r\n"));
});

test("splitting does not depend on where stream chunks end", async () => {
	const chunks = [];
	for (let index = 0; index < mbox.length; index += 7) chunks.push(mbox.slice(index, index + 7));
	assert.deepEqual(await collect(chunks), await collect([mbox]));
});

test("labels are parsed, including quoted, folded and encoded ones", () => {
	assert.deepEqual(parseGmailLabels(Buffer.from('X-Gmail-Labels: Inbox,Unread,"Kunden, alt"\r\n\r\nbody')), ["Inbox", "Unread", "Kunden, alt"]);
	assert.deepEqual(parseGmailLabels(Buffer.from("Subject: x\nX-Gmail-Labels: Sent,\n Projekte\n\nbody")), ["Sent", "Projekte"]);
	assert.deepEqual(parseGmailLabels(Buffer.from("X-Gmail-Labels: =?UTF-8?Q?Entw=C3=BCrfe?=\r\n\r\n")), ["Entwürfe"]);
	assert.deepEqual(parseGmailLabels(Buffer.from("Subject: none\r\n\r\nX-Gmail-Labels: Inbox")), []);
});

test("labels map to sections, folders and read state", () => {
	assert.deepEqual(mapGmailLabels(["Inbox", "Unread", "Newton"]), { destination: { type: "system", section: "inbox" }, read: false, starred: false });
	assert.deepEqual(mapGmailLabels(["Sent", "Inbox"]).destination, { type: "system", section: "sent" });
	assert.deepEqual(mapGmailLabels(["Trash", "Inbox"]).destination, { type: "system", section: "trash" });
	assert.deepEqual(mapGmailLabels(["Papierkorb"]).destination, { type: "system", section: "trash" });
	assert.deepEqual(mapGmailLabels(["Archived", "Starred", "Important", "Newton/Doped"]), { destination: { type: "folder", name: "Newton/Doped" }, read: true, starred: true });
	assert.deepEqual(mapGmailLabels(["Category Promotions", "Opened"]).destination, { type: "system", section: "archived" });
	assert.deepEqual(mapGmailLabels([]).destination, { type: "system", section: "archived" });
});

test("folders can be turned off or filtered by label", () => {
	assert.deepEqual(mapGmailLabels(["Newton"], { folders: false }).destination, { type: "system", section: "archived" });
	const ignore = ["[Superhuman]/", "Save"];
	assert.deepEqual(mapGmailLabels(["[Superhuman]/AI/News", "Save", "Apple"], { ignore }).destination, { type: "folder", name: "Apple" });
	assert.deepEqual(mapGmailLabels(["[Superhuman]", "[Superhuman]/AI"], { ignore }).destination, { type: "system", section: "archived" });
});
