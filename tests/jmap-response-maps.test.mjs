import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("jmap-response-maps", `
	export { mailboxGet, mailboxSet } from "./src/lib/jmap/mailboxes.ts";
	export { emailGet, emailImport, emailSet } from "./src/lib/jmap/emails.ts";
	export { emailSubmissionSet } from "./src/lib/jmap/identities.ts";
	export { processRequest } from "./src/lib/jmap/processor.ts";
`);

const seed = `${sharedMailboxSeed("full_access")}
	INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('f-own', 'delegate', 'mb-delegate', 'Mine', 1);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, folder_id, created_at) VALUES
		('m-own', 'delegate', 'mb-delegate', 'inbound', 'x@example.net', 'delegate@example.com', 'Mine', 'received', NULL, 2);
`;

function context(db, env) {
	return {
		env, db, accountId: "acct", origin: "http://localhost", createdIds: {}, memo: undefined,
		auth: { userId: "delegate", user: { id: "delegate", email: "delegate@example.com", role: "user" }, scopes: ["jmap"], mailboxIds: null },
	};
}

// A literal {"__proto__": x} would set the prototype instead of the key, so
// hostile-key args are parsed the way they arrive on the wire.
const parsed = (json) => JSON.parse(json);
const DRAFTS = "mb-delegate~drafts";
const VALID_FOLDER = parsed(`{"__proto__":{"name":"Projects","parentId":"mb-delegate"}}`);
const VALID_DRAFT = parsed(`{"__proto__":{"mailboxIds":{"${DRAFTS}":true},"from":[{"email":"delegate@example.com"}],"to":[{"email":"x@example.net"}]}}`);

test("Mailbox/set create under a __proto__ key still echoes the created record", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, seed);
	const result = await app.mailboxSet(context(db, env), { create: VALID_FOLDER });
	assert.ok(Object.hasOwn(result.created, "__proto__"), JSON.stringify(result.created));
	const jmapId = result.created["__proto__"].id;
	assert.match(jmapId, /^mb-delegate~f~/);
	assert.equal(sqlite.prepare("SELECT name FROM folders WHERE id = ?").get(jmapId.split("~f~")[1]).name, "Projects");
});

test("a rejected Mailbox record under __proto__ still reports its notCreated error", async (t) => {
	const { env, db } = await newDatabase(t, seed);
	const result = await app.mailboxSet(context(db, env), { create: parsed(`{"__proto__":{"parentId":"mb-delegate"}}`) });
	assert.ok(Object.hasOwn(result.notCreated, "__proto__"), JSON.stringify(result.notCreated));
	assert.equal(result.notCreated["__proto__"].type, "invalidProperties");
});

test("Mailbox/set update and destroy under __proto__ report per-record errors", async (t) => {
	const { env, db } = await newDatabase(t, seed);
	const updated = await app.mailboxSet(context(db, env), { update: parsed(`{"__proto__":{"name":"x"}}`) });
	assert.ok(Object.hasOwn(updated.notUpdated, "__proto__"), JSON.stringify(updated.notUpdated));
	assert.equal(updated.notUpdated["__proto__"].type, "notFound");
	const destroyed = await app.mailboxSet(context(db, env), { destroy: ["__proto__"] });
	assert.ok(Object.hasOwn(destroyed.notDestroyed, "__proto__"), JSON.stringify(destroyed.notDestroyed));
	assert.equal(destroyed.notDestroyed["__proto__"].type, "notFound");
});

test("Email/set create, update and destroy under __proto__ keys keep their entries", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, seed);
	const created = await app.emailSet(context(db, env), { create: VALID_DRAFT });
	assert.ok(Object.hasOwn(created.created, "__proto__"), JSON.stringify(created.created));
	const draftId = created.created["__proto__"].id;
	assert.equal(sqlite.prepare("SELECT status FROM messages WHERE id = ?").get(draftId).status, "draft");

	const updated = await app.emailSet(context(db, env), { update: parsed(`{"__proto__":{"keywords":{"$seen":true}}}`) });
	assert.ok(Object.hasOwn(updated.notUpdated, "__proto__"), JSON.stringify(updated.notUpdated));
	assert.equal(updated.notUpdated["__proto__"].type, "notFound");

	const destroyed = await app.emailSet(context(db, env), { destroy: ["__proto__"] });
	assert.ok(Object.hasOwn(destroyed.notDestroyed, "__proto__"), JSON.stringify(destroyed.notDestroyed));
	assert.equal(destroyed.notDestroyed["__proto__"].type, "notFound");
});

test("a failed Email/set create under __proto__ reports notCreated", async (t) => {
	const { env, db } = await newDatabase(t, seed);
	const result = await app.emailSet(context(db, env), { create: parsed(`{"__proto__":{"mailboxIds":{"${DRAFTS}":true}}}`) });
	assert.ok(Object.hasOwn(result.notCreated, "__proto__"), JSON.stringify(result.notCreated));
	assert.equal(result.notCreated["__proto__"].type, "invalidProperties");
});

test("Email/import under a __proto__ key reports its per-record error", async (t) => {
	const { env, db } = await newDatabase(t, seed);
	const result = await app.emailImport(context(db, env), {
		emails: parsed(`{"__proto__":{"mailboxIds":{"${DRAFTS}":true},"blobId":"up~gone"}}`),
	});
	assert.ok(Object.hasOwn(result.notCreated, "__proto__"), JSON.stringify(result.notCreated));
	assert.equal(result.notCreated["__proto__"].type, "blobNotFound");
});

test("EmailSubmission/set under a __proto__ key reports its per-record error", async (t) => {
	const { env, db } = await newDatabase(t, seed);
	const result = await app.emailSubmissionSet(context(db, env), {
		create: parsed(`{"__proto__":{"emailId":"msg_none","identityId":"bogus"}}`),
	});
	assert.ok(Object.hasOwn(result.notCreated, "__proto__"), JSON.stringify(result.notCreated));
	assert.equal(result.notCreated["__proto__"].type, "invalidProperties");
});

test("an emailId naming an inherited member is a missing draft, not a crash", async (t) => {
	const { env, db } = await newDatabase(t, seed);
	const result = await app.emailSubmissionSet(context(db, env), {
		create: { sub1: { emailId: "constructor", identityId: "mb-delegate~delegate@example.com" } },
	});
	assert.equal(result.notCreated.sub1.type, "invalidProperties", JSON.stringify(result.notCreated));
});

test("a __proto__ creation id resolves through #__proto__ in a later call", async (t) => {
	const { env, db } = await newDatabase(t, seed);
	const response = await app.processRequest(context(db, env), {
		using: [],
		methodCalls: [
			["Mailbox/set", { create: VALID_FOLDER }, "a"],
			["Mailbox/get", { ids: ["#__proto__"] }, "b"],
		],
	});
	const [[, set], [, get]] = response.methodResponses;
	const jmapId = set.created["__proto__"].id;
	assert.ok(Object.hasOwn(response.createdIds, "__proto__"), JSON.stringify(response.createdIds));
	assert.equal(response.createdIds["__proto__"], jmapId);
	assert.equal(get.list.length, 1, JSON.stringify(get));
	assert.equal(get.list[0].id, jmapId);
});

test("Mailbox/get properties never picks inherited members", async (t) => {
	const { env, db } = await newDatabase(t, seed);
	const result = await app.mailboxGet(context(db, env), { ids: ["mb-delegate"], properties: ["id", "name", "constructor", "__proto__", "toString"] });
	assert.equal(result.list.length, 1);
	assert.deepEqual(Object.keys(result.list[0]).sort(), ["id", "name"]);
});

test("Email/get properties never picks inherited members", async (t) => {
	const { env, db } = await newDatabase(t, seed);
	const result = await app.emailGet(context(db, env), { ids: ["m-own"], properties: ["id", "subject", "constructor", "__proto__", "toString", "header:subject"] });
	assert.equal(result.list.length, 1);
	assert.deepEqual(Object.keys(result.list[0]).sort(), ["header:subject", "id", "subject"]);
});

test("ordinary create, update, destroy and #refs are unchanged", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, seed);
	const response = await app.processRequest(context(db, env), {
		using: [],
		methodCalls: [
			["Mailbox/set", { create: { f1: { name: "Projects", parentId: "mb-delegate" } } }, "a"],
			["Mailbox/get", { ids: ["#f1"] }, "b"],
		],
	});
	const [[, set], [, get]] = response.methodResponses;
	assert.ok(set.created.f1?.id, JSON.stringify(set));
	assert.equal(get.list[0].name, "Projects");
	assert.equal(response.createdIds.f1, set.created.f1.id);

	const updated = await app.mailboxSet(context(db, env), { update: { "mb-delegate~f~f-own": { name: "Renamed" } } });
	assert.deepEqual(updated.updated, { "mb-delegate~f~f-own": null });
	assert.equal(sqlite.prepare("SELECT name FROM folders WHERE id = 'f-own'").get().name, "Renamed");

	const destroyed = await app.mailboxSet(context(db, env), { destroy: ["mb-delegate~f~f-own"], onDestroyRemoveEmails: true });
	assert.deepEqual(destroyed.destroyed, ["mb-delegate~f~f-own"]);

	const picked = await app.mailboxGet(context(db, env), { ids: ["mb-delegate"], properties: ["id", "name", "role"] });
	assert.deepEqual(Object.keys(picked.list[0]).sort(), ["id", "name", "role"]);
});
