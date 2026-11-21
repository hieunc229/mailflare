import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({
	name: "app-passwords-utils",
	entryPoint: "src/components/settings/app-passwords-utils.ts",
	mocks: {
		"@/lib/auth/client": "export async function authFetch(url, init){globalThis.appPwUtils.calls.push({url, init}); return globalThis.appPwUtils.respond(url, init)}",
	},
});
const { appPasswordProtocolName, createAppPassword, groupAppPassword, loadAppPasswords, revokeAppPassword } = await fixture.import();
after(() => { delete globalThis.appPwUtils; fixture.dispose(); });

function respond(status, body) {
	globalThis.appPwUtils = { calls: [], respond: () => Response.json(body, { status }) };
}

test("the password is shown in groups of four", () => {
	assert.equal(groupAppPassword("abcdefghijklmnop"), "abcd efgh ijkl mnop");
	assert.equal(groupAppPassword("abcdef"), "abcd ef");
	assert.equal(groupAppPassword(""), "");
});

test("protocols keep their technical names", () => {
	assert.deepEqual(["jmap", "caldav", "carddav", "imap", "submission", "other"].map(appPasswordProtocolName), ["JMAP", "CalDAV", "CardDAV", "IMAP", "SMTP", "other"]);
});

test("creating sends the step-up token and does not bounce to sign-in on a 401", async () => {
	respond(200, { id: "k1", name: "Phone", key: "abcdefghijklmnop", protocols: ["jmap"], mailboxIds: ["m1"] });
	const created = await createAppPassword({ name: "Phone", protocols: ["jmap"], mailboxIds: ["m1"] }, "sup-token-1");
	assert.equal(created.key, "abcdefghijklmnop");
	const { url, init } = globalThis.appPwUtils.calls[0];
	assert.equal(url, "/api/app-passwords");
	assert.equal(init.method, "POST");
	assert.equal(init.redirectOnUnauthorized, false);
	assert.deepEqual(JSON.parse(init.body), { name: "Phone", protocols: ["jmap"], mailboxIds: ["m1"], stepUpToken: "sup-token-1" });
});

test("a failed create keeps the server's code so the dialog can translate it", async () => {
	respond(401, { error: "Confirm your identity before continuing.", code: "verification_required" });
	await assert.rejects(createAppPassword({ name: "x", protocols: ["jmap"], mailboxIds: ["m1"] }, "sup-token-1"), (error) => error.code === "verification_required");
	respond(403, { error: "Mailbox not found" });
	await assert.rejects(createAppPassword({ name: "x", protocols: ["jmap"], mailboxIds: ["m1"] }, "sup-token-1"), (error) => error.message === "Mailbox not found" && error.code === undefined);
	respond(200, {});
	await assert.rejects(createAppPassword({ name: "x", protocols: ["jmap"], mailboxIds: ["m1"] }, "sup-token-1"), /create/i);
});

test("loading and revoking use the app password routes", async () => {
	respond(200, { appPasswords: [{ id: "k1" }], availableProtocols: ["jmap"] });
	assert.deepEqual((await loadAppPasswords()).availableProtocols, ["jmap"]);
	assert.equal(globalThis.appPwUtils.calls[0].url, "/api/app-passwords");
	respond(200, { ok: true });
	await revokeAppPassword("key/1");
	assert.equal(globalThis.appPwUtils.calls[0].url, "/api/app-passwords/key%2F1");
	assert.equal(globalThis.appPwUtils.calls[0].init.method, "DELETE");
	respond(404, { error: "App password not found" });
	await assert.rejects(revokeAppPassword("nope"), /not found/);
	respond(500, {});
	await assert.rejects(loadAppPasswords());
});
