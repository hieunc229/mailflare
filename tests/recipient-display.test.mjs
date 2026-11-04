import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-recipient-display-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		// The DOM-only HTML pipeline is not needed here and its parser deps do not bundle for node.
		alias: { "@/lib/email/html": join(root, "tests/stubs/email-html.mjs"), "@": join(root, "src") },
		external: ["react", "react-dom", "next", "next/*"],
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const display = await bundle("src/lib/email/recipient-display.ts", "display.mjs");
const thread = await bundle("src/components/messages/conversation-thread-utils.ts", "thread.mjs");
const contacts = await bundle("src/lib/contacts/utils.ts", "contacts.mjs");
const parties = await bundle("src/app/(dashboard)/inbox/[messageId]/utils.ts", "parties.mjs");
const validators = await bundle("src/lib/validators.ts", "validators.mjs");

test("address style drops the display name", () => {
	assert.equal(display.formatRecipientAddress("Catch All <alias@example.com>", "address"), "alias@example.com");
	assert.equal(display.formatRecipientAddress('"Chen, Maya" <maya@example.com>', "address"), "maya@example.com");
	assert.equal(display.formatRecipientAddress("editor@example.com", "address"), "editor@example.com");
});

test("full style keeps Name <mailbox> and leaves a bare address alone", () => {
	assert.equal(display.formatRecipientAddress("Redacción <editor@example.com>", "full"), "Redacción <editor@example.com>");
	assert.equal(display.formatRecipientAddress('"Chen, Maya" <maya@example.com>', "full"), "Chen, Maya <maya@example.com>");
	assert.equal(display.formatRecipientAddress("editor@example.com", "full"), "editor@example.com");
	assert.equal(
		display.formatRecipientAddressList("Ada <ada@example.com>, bob@example.com", "full"),
		"Ada <ada@example.com>, bob@example.com",
	);
});

test("contact name is never the formatted label", () => {
	assert.equal(display.recipientContactName('"Chen, Maya" <maya@example.com>'), "Chen, Maya");
	assert.equal(display.recipientContactName("editor@example.com"), "editor@example.com");
});

test("thread cards follow the same style and still collapse a long list", () => {
	const message = {
		toAddr: "Ada <ada@example.com>, Bob <bob@example.com>, Cid <cid@example.com>, Dee <dee@example.com>",
		ccAddr: "",
	};
	assert.equal(thread.getConversationRecipients(message, "address"), "ada@example.com, bob@example.com, cid@example.com, +1");
	assert.equal(
		thread.getConversationRecipients(message, "full"),
		"Ada <ada@example.com>, Bob <bob@example.com>, Cid <cid@example.com>, +1",
	);
});

test("inbound To is the address, not me", () => {
	const header = parties.getMessageHeaderParties({
		direction: "inbound",
		fromAddr: "Ada Lovelace <ada@example.com>",
		toAddr: "Catch All <alias@example.com>",
	});
	assert.equal(header.toName, "alias@example.com");
	assert.equal(header.toName.includes("me"), false);

	const several = parties.getMessageHeaderParties({
		direction: "inbound",
		fromAddr: "ada@example.com",
		toAddr: "one@example.com, Two <two@example.com>",
	});
	assert.equal(several.toName, "one@example.com, two@example.com");
});

test("outbound To still prefers the contact name", () => {
	const header = parties.getMessageHeaderParties({
		direction: "outbound",
		fromAddr: "owner@example.com",
		toAddr: "Ada <ada@example.com>",
		toContactName: "Ada Lovelace",
	});
	assert.equal(header.toName, "Ada Lovelace");
});

test("a message's own From name beats a shared contact's learned name", () => {
	const shared = { displayName: "LiveKit Hiring Team", source: "inbound" };
	assert.equal(contacts.getSenderDisplayName('"PostHog Team" <no-reply@ashbyhq.com>', shared), "PostHog Team");
	assert.equal(
		contacts.getSenderDisplayName('"LiveKit Hiring Team" <no-reply@ashbyhq.com>', { displayName: "PostHog Team", source: "outbound" }),
		"LiveKit Hiring Team",
	);
});

test("a manually named contact overrides the message's From name", () => {
	assert.equal(
		contacts.getSenderDisplayName('"PostHog Team" <no-reply@ashbyhq.com>', { displayName: "Ashby Recruiting", source: "manual" }),
		"Ashby Recruiting",
	);
});

test("the learned contact name fills in when the message has no From name", () => {
	assert.equal(
		contacts.getSenderDisplayName("no-reply@ashbyhq.com", { displayName: "PostHog Team", source: "inbound" }),
		"PostHog Team",
	);
	assert.equal(contacts.getSenderDisplayName("no-reply@ashbyhq.com", null), null);
});

test("the setting accepts only a boolean", () => {
	assert.equal(validators.updateRecipientAddressSettingsSchema.parse({ enabled: true }).enabled, true);
	assert.equal(validators.updateRecipientAddressSettingsSchema.parse({ enabled: false }).enabled, false);
	assert.throws(() => validators.updateRecipientAddressSettingsSchema.parse({ enabled: "yes" }));
});

test("migration adds the user column off by default and the journal lists it", () => {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE users (id text primary key)");
	db.exec(readFileSync(join(root, "drizzle/migrations/0050_add_show_full_recipient_addresses.sql"), "utf8"));
	db.exec("INSERT INTO users (id) VALUES ('u')");
	assert.equal(db.prepare("SELECT show_full_recipient_addresses AS value FROM users").get().value, 0);

	const journal = JSON.parse(readFileSync(join(root, "drizzle/migrations/meta/_journal.json"), "utf8"));
	const entry = journal.entries.find((item) => item.tag === "0050_add_show_full_recipient_addresses");
	assert.equal(entry?.idx, 42);
});
