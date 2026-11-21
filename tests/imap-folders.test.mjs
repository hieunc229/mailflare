import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-imap-folders-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export * from "./src/lib/imap/folders.ts";
			export { mailboxIdsFor } from "./src/lib/jmap/email-objects.ts";
			export { statusToRole } from "./src/lib/jmap/ids.ts";
		`,
		resolveDir: root,
		sourcefile: "imap-folders-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const folders = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const { folderKeyOf, mailboxIdsFor, encodeFolderName, decodeFolderName, listFolders, systemFolderName, keyOfSystemFolderName } = folders;

const STATUSES = ["received", "sent", "queued", "failed", "draft", "archived", "spam", "trash", "sending", "unknown"];

test("folderKeyOf agrees with mailboxIdsFor for every status and folder combination", () => {
	for (const status of STATUSES) {
		for (const folderId of [null, "fld1"]) {
			for (const mailboxId of [null, "m1"]) {
				const row = { mailboxId, folderId, status };
				const ids = Object.keys(mailboxIdsFor(row));
				const key = folderKeyOf(row);
				if (ids.length === 0) {
					assert.equal(key, null, JSON.stringify(row));
					continue;
				}
				assert.equal(ids.length, 1);
				const [, kind, extra] = ids[0].split("~");
				if (folderId) assert.equal(key, "f:fld1");
				else assert.equal(key, kind, JSON.stringify(row));
				assert.equal(extra === undefined || folderId !== null, true);
			}
		}
	}
});

test("queued, failed and sent rows share the Sent folder, and an unknown status has no folder", () => {
	for (const status of ["sent", "queued", "failed"]) assert.equal(folderKeyOf({ mailboxId: "m1", folderId: null, status }), "sent");
	assert.equal(folderKeyOf({ mailboxId: "m1", folderId: null, status: "sending" }), null);
	assert.equal(folderKeyOf({ mailboxId: null, folderId: null, status: "received" }), null);
});

test("system folders have fixed English names and special-use attributes", () => {
	assert.equal(systemFolderName("inbox"), "INBOX");
	assert.equal(systemFolderName("junk"), "Junk");
	assert.equal(keyOfSystemFolderName("inbox"), "inbox");
	assert.equal(keyOfSystemFolderName("INBOX"), "inbox");
	assert.equal(keyOfSystemFolderName("Sent"), "sent");
	assert.equal(keyOfSystemFolderName("sent"), null, "only INBOX is case-insensitive");
	assert.equal(keyOfSystemFolderName("Nope"), null);
});

test("modified UTF-7 round trips and matches RFC 3501 examples", () => {
	assert.equal(encodeFolderName("Entwürfe"), "Entw&APw-rfe");
	assert.equal(encodeFolderName("A&B"), "A&-B");
	assert.equal(encodeFolderName("~peter/mail/台北/日本語"), "~peter/mail/&U,BTFw-/&ZeVnLIqe-");
	assert.equal(encodeFolderName("😀"), "&2D3eAA-");
	for (const name of ["INBOX", "Clients/Acme", "Entwürfe", "A&B", "日本語", "😀 party", "a - b", "&"]) {
		assert.equal(decodeFolderName(encodeFolderName(name)), name, name);
	}
	assert.equal(decodeFolderName("~peter/mail/&U,BTFw-/&ZeVnLIqe-"), "~peter/mail/台北/日本語");
});

test("malformed modified UTF-7 is rejected, not guessed", () => {
	for (const bad of ["&", "&AAA", "&AP8", "&!!-", "&APw", "A&APw-&APw-B&", "ä", "a\u0000b", "&AP-", "&2D0-", "&3gA-"]) {
		assert.equal(decodeFolderName(bad), null, JSON.stringify(bad));
	}
});

test("a name encoded in a shifted run that needlessly spans ASCII is rejected", () => {
	// "&AGE-" encodes the printable ASCII letter "a"; RFC 3501 forbids shifting for it.
	assert.equal(decodeFolderName("&AGE-"), null);
});

test("listing adds a placeholder for a missing parent and marks children", () => {
	const listed = listFolders([{ id: "f1", name: "Clients/Acme" }, { id: "f2", name: "Clients/Beta/2026" }, { id: "f3", name: "Misc" }]);
	const byName = Object.fromEntries(listed.map((entry) => [entry.name, entry]));
	assert.deepEqual(byName["Clients"], { name: "Clients", key: null, attributes: ["\\Noselect", "\\HasChildren"] });
	assert.deepEqual(byName["Clients/Beta"], { name: "Clients/Beta", key: null, attributes: ["\\Noselect", "\\HasChildren"] });
	assert.deepEqual(byName["Clients/Acme"], { name: "Clients/Acme", key: "f:f1", attributes: ["\\HasNoChildren"] });
	assert.deepEqual(byName["Misc"], { name: "Misc", key: "f:f3", attributes: ["\\HasNoChildren"] });
	assert.deepEqual(byName["Sent"].attributes, ["\\Sent", "\\HasNoChildren"]);
	assert.equal(listed[0].name, "INBOX");
});

test("a real folder that is also a parent keeps its key and gains HasChildren", () => {
	const listed = listFolders([{ id: "f1", name: "Clients" }, { id: "f2", name: "Clients/Acme" }]);
	const clients = listed.find((entry) => entry.name === "Clients");
	assert.deepEqual(clients, { name: "Clients", key: "f:f1", attributes: ["\\HasChildren"] });
});

test("a user folder named like a system folder is listed under a distinct name", () => {
	const listed = listFolders([{ id: "f1", name: "Sent" }, { id: "f2", name: "inbox" }]);
	const names = listed.map((entry) => entry.name);
	assert.equal(new Set(names).size, names.length, "names are unique");
	assert.deepEqual(listed.find((entry) => entry.key === "f:f1").name, "Sent (folder)");
	assert.deepEqual(listed.find((entry) => entry.key === "f:f2").name, "inbox (folder)");
	assert.equal(listed.find((entry) => entry.key === "sent").name, "Sent");
});

test("names that still collide after the system rename get a stable suffix, whatever the input order", () => {
	const input = [
		{ id: "f1", name: "Sent" },
		{ id: "f2", name: "Sent (folder)" },
		{ id: "f3", name: "Work" },
		{ id: "f4", name: "Work" },
		{ id: "f5", name: "SENT" },
	];
	const reversed = [...input].reverse();
	const first = listFolders(input);
	const names = first.map((entry) => entry.name);
	assert.equal(new Set(names).size, names.length, `names are unique: ${names.join(" | ")}`);
	const byKey = (listing) => Object.fromEntries(listing.filter((entry) => entry.key?.startsWith("f:")).map((entry) => [entry.key, entry.name]));
	assert.deepEqual(byKey(listFolders(reversed)), byKey(first), "the same folder gets the same name in any order");
	assert.equal(byKey(first)["f:f3"], "Work", "the first claimant keeps the plain name");
	assert.notEqual(byKey(first)["f:f4"], "Work");
	assert.equal(first.find((entry) => entry.key === "sent").name, "Sent", "system names are never taken");
});

test("children of INBOX in any case hang under the real INBOX, not under a second placeholder", () => {
	const listed = listFolders([{ id: "f1", name: "Inbox/Receipts" }, { id: "f2", name: "inbox/Deep/Er" }]);
	const names = listed.map((entry) => entry.name);
	assert.ok(names.includes("INBOX/Receipts"));
	assert.ok(names.includes("INBOX/Deep/Er"));
	assert.ok(!names.some((name) => /^inbox/i.test(name) && !name.startsWith("INBOX")), names.join(" | "));
	assert.equal(names.filter((name) => name.toUpperCase() === "INBOX").length, 1);
	assert.deepEqual(listed[0], { name: "INBOX", key: "inbox", attributes: ["\\HasChildren"] });
	assert.deepEqual(listed.find((entry) => entry.name === "INBOX/Deep").attributes, ["\\Noselect", "\\HasChildren"]);
});

test("empty path segments never produce placeholder names", () => {
	const listed = listFolders([{ id: "f1", name: "a//b" }, { id: "f2", name: "/lead" }, { id: "f3", name: "trail/" }]);
	for (const entry of listed.filter((item) => item.key === null)) {
		assert.ok(entry.name && entry.name.split("/").every(Boolean), `placeholder ${JSON.stringify(entry.name)} has an empty segment`);
	}
	assert.ok(listed.some((entry) => entry.key === "f:f1" && entry.name === "a//b"), "the real folders are still listed");
	assert.ok(listed.some((entry) => entry.key === "f:f2") && listed.some((entry) => entry.key === "f:f3"));
});

test("adjacent encoded runs are not canonical and are rejected", () => {
	assert.equal(decodeFolderName("&APw-&APw-"), null);
	assert.equal(decodeFolderName("x&APw-&AOk-y"), null);
	assert.equal(decodeFolderName("&APw-&-"), "ü&", "a run followed by a literal ampersand is fine");
	assert.equal(decodeFolderName("&-&APw-"), "&ü");
	assert.equal(encodeFolderName("üé"), "&APwA6Q-", "the encoder joins them into one run");
	assert.equal(decodeFolderName("&APwA6Q-"), "üé");
});

test("the encoder never emits a lone surrogate", () => {
	for (const name of ["a\ud800b", "\udc00", "x\ud83d", "\ud83d😀", "\ude00\ud83d"]) {
		const decoded = decodeFolderName(encodeFolderName(name));
		assert.notEqual(decoded, null, JSON.stringify(name));
		assert.ok(decoded.isWellFormed(), `${JSON.stringify(name)} decoded to an ill-formed string`);
		assert.ok(decoded.includes("�"));
	}
	assert.equal(decodeFolderName(encodeFolderName("a\ud800b")), "a�b");
	assert.equal(decodeFolderName(encodeFolderName("😀")), "😀", "a valid pair is kept");
});
