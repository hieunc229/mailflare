import test from "node:test";
import assert from "node:assert/strict";
import { applyImportHints, getImportMessageHints } from "../src/lib/import/message-hints-utils.ts";

const raw = (headers) => new TextEncoder().encode(`${headers}\n\nbody`).buffer;

test("mbox Status header sets read state", () => {
	assert.equal(getImportMessageHints(raw("Status: RO\nSubject: a")).read, true);
	assert.equal(getImportMessageHints(raw("Status: O\nSubject: a")).read, false);
	assert.equal(getImportMessageHints(raw("Subject: a")).read, undefined);
});

test("Gmail labels and spam flag pick spam or trash", () => {
	assert.equal(getImportMessageHints(raw("X-Gmail-Labels: Spam,Unread")).section, "spam");
	assert.equal(getImportMessageHints(raw("X-Gmail-Labels: Spam,Unread")).read, false);
	assert.equal(getImportMessageHints(raw("X-Gmail-Labels: Trash")).section, "trash");
	assert.equal(getImportMessageHints(raw("X-Spam-Flag: YES")).section, "spam");
	assert.equal(getImportMessageHints(raw("X-Gmail-Labels: Inbox")).section, undefined);
});

test("hints only refine the inbox destination", () => {
	const spam = { section: "spam" };
	assert.deepEqual(applyImportHints({ type: "system", section: "inbox" }, spam), { type: "system", section: "spam" });
	assert.deepEqual(applyImportHints({ type: "system", section: "sent" }, spam), { type: "system", section: "sent" });
	assert.deepEqual(applyImportHints({ type: "folder", folderId: "f" }, spam), { type: "folder", folderId: "f" });
});
