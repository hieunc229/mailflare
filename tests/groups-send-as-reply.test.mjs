import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-groups-reply-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { getReplyRecipients, hasAdditionalRecipients } from "./src/components/message-actions/utils.ts";
			export { getOwnAddressForMessage, getPersonalAddresses } from "./src/app/(dashboard)/inbox/[messageId]/utils.ts";
		`,
		resolveDir: root,
		sourcefile: "groups-reply-entry.ts",
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
const { getReplyRecipients, hasAdditionalRecipients, getOwnAddressForMessage, getPersonalAddresses } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const senderAddresses = ["alice@example.com", "alias@example.com", "team@example.com"];
const groupAddresses = ["team@example.com"];
const toTheGroup = { direction: "inbound", fromAddr: "Bob <bob@gmail.com>", toAddr: "team@example.com", ccAddr: "carol@example.org", replyTo: null, providerMessageId: null, references: null, threadId: null };

test("the personal addresses are the sender addresses minus the groups, compared without case", () => {
	assert.deepEqual(getPersonalAddresses(senderAddresses, ["TEAM@example.com"]), ["alice@example.com", "alias@example.com"]);
	assert.deepEqual(getPersonalAddresses(senderAddresses, undefined), senderAddresses);
});

test("a reply to mail sent to the group defaults to the member's own address, never the group", () => {
	const personal = getPersonalAddresses(senderAddresses, groupAddresses);
	assert.equal(getOwnAddressForMessage(toTheGroup, personal), "alice@example.com");
	assert.equal(getOwnAddressForMessage(toTheGroup, senderAddresses), "team@example.com", "the unfiltered list is what used to pick the group");
});

test("reply-all from the personal address keeps the group among the recipients", () => {
	const personal = getPersonalAddresses(senderAddresses, groupAddresses);
	const all = getReplyRecipients(toTheGroup, personal, "replyAll");
	assert.deepEqual(all.to, ["Bob <bob@gmail.com>"]);
	assert.deepEqual(all.cc, ["team@example.com", "carol@example.org"]);
	assert.equal(hasAdditionalRecipients(toTheGroup, personal), true);
	assert.deepEqual(getReplyRecipients(toTheGroup, senderAddresses, "replyAll").cc, ["carol@example.org"], "the unfiltered list used to drop the group");
});

test("a reply to a message the member sent as the group keeps that From", () => {
	const sent = { ...toTheGroup, direction: "outbound", fromAddr: "\"Team\" <team@example.com>", toAddr: "x@ext.com" };
	assert.equal(getOwnAddressForMessage(sent, getPersonalAddresses(senderAddresses, groupAddresses)), "team@example.com");
});
