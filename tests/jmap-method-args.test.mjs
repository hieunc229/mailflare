import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

/**
 * Method-arg shape edges: an `args.*` value of the wrong JSON type used to
 * throw a TypeError inside the method, land in the per-call catch-all and come
 * back as `serverFail` (plus a console.error) — a client/protocol error labelled
 * as a server bug. RFC 8620 §3.6.2/§5.3 wants `invalidArguments` for arg-level
 * type violations, and per-record `invalidProperties`/`notFound` inside
 * create/update maps, because /set calls are built for partial failure.
 *
 * Everything runs through `processRequest` against a real migrated SQLite
 * database, so the assertions observe the exact error type a JMAP client gets.
 */
const { app, newDatabase } = await loadApp("jmap-method-args", `export { processRequest } from "./src/lib/jmap/processor.ts";`);
// A second bundle with the real send path replaced, so the EmailSubmission/set
// tests can observe a successful submission next to a malformed record.
const { app: sendApp, newDatabase: newSendDb } = await loadApp("jmap-method-args-send", `export { processRequest } from "./src/lib/jmap/processor.ts";`, {
	mocks: { "@/lib/email/send": `export async function sendEmail() { return { messageId: "sent-x" }; }` },
});

const SEED = `
	INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', 'admin', 0);
	INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', 0);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 0);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, read, private_draft, created_at) VALUES
		('m-1', 'u1', 'mb1', 'inbound', 'a@x.test', 'kevin@example.com', 'Hi', 'received', 0, 0, 1);
	INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld1', 'u1', 'mb1', 'Old', 0);
`;

const context = (db, env) => ({
	env,
	db,
	accountId: "u1",
	origin: "http://test",
	createdIds: {},
	memo: undefined,
	auth: { userId: "u1", user: { id: "u1", email: "kevin@example.com", role: "admin" }, scopes: ["jmap"], mailboxIds: null },
});

async function invoke(t, calls, seed = SEED) {
	const { env, db } = await newDatabase(t, seed);
	const response = await app.processRequest(context(db, env), {
		using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
		methodCalls: calls,
	});
	return response.methodResponses;
}

async function single(t, name, args, seed) {
	const [[responseName, result]] = await invoke(t, [[name, args, "c"]], seed);
	return [responseName, result];
}

const expectError = async (t, name, args, seed) => {
	const [responseName, result] = await single(t, name, args, seed);
	assert.equal(responseName, "error", `${name} ${JSON.stringify(args)} should answer a method error, got ${JSON.stringify(result)}`);
	return result;
};

const expectSetError = async (t, name, args, bucket, key, seed) => {
	const [responseName, result] = await single(t, name, args, seed);
	assert.equal(responseName, name, `${name} ${JSON.stringify(args)} should not fail the whole call, got ${JSON.stringify(result)}`);
	assert.ok(result[bucket][key], `${name} should report ${key} in ${bucket}: ${JSON.stringify(result)}`);
	return result[bucket][key];
};

test("a non-array destroy is invalidArguments, not serverFail", async (t) => {
	for (const name of ["Mailbox/set", "Email/set", "Identity/set", "EmailSubmission/set"]) {
		for (const destroy of [5, {}, "x"]) {
			const error = await expectError(t, name, { destroy }, undefined);
			assert.equal(error.type, "invalidArguments", `${name} destroy=${JSON.stringify(destroy)}`);
		}
	}
});

test("a null create record is a per-record invalidProperties, not serverFail", async (t) => {
	for (const name of ["Mailbox/set", "Email/set", "EmailSubmission/set"]) {
		const error = await expectSetError(t, name, { create: { x: null } }, "notCreated", "x");
		assert.equal(error.type, "invalidProperties", name);
	}
	// Identity/set already rejects every create per record.
	const forbidden = await expectSetError(t, "Identity/set", { create: { x: null } }, "notCreated", "x");
	assert.equal(forbidden.type, "forbidden");
});

test("a null update patch is a per-record invalidProperties, not serverFail", async (t) => {
	const mailbox = await expectSetError(t, "Mailbox/set", { update: { mb1: null } }, "notUpdated", "mb1");
	assert.equal(mailbox.type, "invalidProperties");
	const email = await expectSetError(t, "Email/set", { update: { "m-1": null } }, "notUpdated", "m-1");
	assert.equal(email.type, "invalidProperties");
});

test("non-string ids in a destroy list resolve to per-record notFound", async (t) => {
	const [responseName, result] = await single(t, "Mailbox/set", { destroy: [5, null, "mb1~inbox"] });
	assert.equal(responseName, "Mailbox/set", JSON.stringify(result));
	assert.equal(result.notDestroyed[malformedKey(0)]?.type, "notFound");
	assert.equal(result.notDestroyed[malformedKey(1)]?.type, "notFound");
	// The system inbox is real but cannot be destroyed.
	assert.equal(result.notDestroyed["mb1~inbox"]?.type, "forbidden");
});

test("non-array sort on Email/query is invalidArguments", async (t) => {
	for (const sort of ["x", { length: 1 }, 5, [null], [5]]) {
		const error = await expectError(t, "Email/query", { sort });
		assert.equal(error.type, "invalidArguments", `sort=${JSON.stringify(sort)}`);
	}
});

test("non-object filter on Email/query is invalidArguments", async (t) => {
	for (const filter of ["x", 5, true]) {
		const error = await expectError(t, "Email/query", { filter });
		assert.equal(error.type, "invalidArguments", `filter=${JSON.stringify(filter)}`);
	}
});

test("non-array filter conditions are invalidArguments", async (t) => {
	for (const conditions of ["x", 5, {}, [5], ["x"]]) {
		const error = await expectError(t, "Email/query", { filter: { operator: "AND", conditions } });
		assert.equal(error.type, "invalidArguments", `conditions=${JSON.stringify(conditions)}`);
	}
});

test("non-array inMailboxOtherThan is invalidArguments", async (t) => {
	for (const inMailboxOtherThan of [5, {}, "x"]) {
		const error = await expectError(t, "Email/query", { filter: { inMailboxOtherThan } });
		assert.equal(error.type, "invalidArguments", `inMailboxOtherThan=${JSON.stringify(inMailboxOtherThan)}`);
	}
});

test("non-string inMailboxOtherThan ids are invalidArguments, not a silently broadened filter", async (t) => {
	for (const inMailboxOtherThan of [[5], [[{}]], [null]]) {
		const error = await expectError(t, "Email/query", { filter: { inMailboxOtherThan } });
		assert.equal(error.type, "invalidArguments", `inMailboxOtherThan=${JSON.stringify(inMailboxOtherThan)}`);
	}
	// An unknown string id is still skipped, which is how an empty
	// inMailboxOtherThan list matches everything.
	const [responseName, result] = await single(t, "Email/query", { filter: { inMailboxOtherThan: ["mb-unknown"] } });
	assert.equal(responseName, "Email/query", JSON.stringify(result));
	assert.deepEqual(result.ids, ["m-1"]);
});

test("wrong-typed scalar filter fields are invalidArguments", async (t) => {
	for (const filter of [
		{ inMailbox: 5 },
		{ inMailbox: {} },
		{ from: 5 },
		{ from: {} },
		{ text: 5 },
		{ subject: {} },
		{ before: {} },
		{ before: "not a date" },
		{ minSize: "x" },
		{ minSize: {} },
		{ hasAttachment: "yes" },
		{ hasKeyword: 5 },
	]) {
		const error = await expectError(t, "Email/query", { filter });
		assert.equal(error.type, "invalidArguments", `filter=${JSON.stringify(filter)}`);
	}
});

test("non-array ids and properties on /get calls are invalidArguments", async (t) => {
	for (const [name, args] of [
		["Email/get", { ids: 5 }],
		["Email/get", { ids: { a: 1 } }],
		["Email/get", { ids: ["m-1"], properties: 5 }],
		["Email/get", { ids: ["m-1"], properties: [5] }],
		["Thread/get", { ids: 5 }],
		["Thread/get", { ids: { a: 1 } }],
		["Mailbox/get", { ids: 5 }],
		["Mailbox/get", { properties: { a: 1 } }],
		["Identity/get", { ids: "x" }],
		["SearchSnippet/get", { emailIds: 5 }],
		["SearchSnippet/get", { emailIds: { a: 1 } }],
	]) {
		const error = await expectError(t, name, args);
		assert.equal(error.type, "invalidArguments", `${name} ${JSON.stringify(args)}`);
	}
});

test("wrong-typed Mailbox/query filter fields are invalidArguments", async (t) => {
	for (const filter of [{ name: 5 }, { name: {} }, 5, "x", { parentId: {} }, { hasAnyRole: "yes" }]) {
		const error = await expectError(t, "Mailbox/query", { filter });
		assert.equal(error.type, "invalidArguments", `filter=${JSON.stringify(filter)}`);
	}
});

test("a wrong-typed SearchSnippet filter is invalidArguments", async (t) => {
	for (const filter of [{ text: 5 }, { text: {} }, 5, "x"]) {
		const error = await expectError(t, "SearchSnippet/get", { filter });
		assert.equal(error.type, "invalidArguments", `filter=${JSON.stringify(filter)}`);
	}
});

test("non-array attachments on an Email/set create are a per-record invalidProperties", async (t) => {
	const create = {
		mailboxIds: { "mb1~drafts": true },
		from: [{ email: "kevin@example.com" }],
	};
	for (const attachments of [5, {}, "x"]) {
		const error = await expectSetError(t, "Email/set", { create: { x: { ...create, attachments } } }, "notCreated", "x");
		assert.equal(error.type, "invalidProperties", `attachments=${JSON.stringify(attachments)}`);
		assert.deepEqual(error.properties, ["attachments"]);
	}
	// Malformed parts inside the list are skipped like an unreadable blobId.
	const [responseName, result] = await single(t, "Email/set", { create: { x: { ...create, attachments: [null, 5, { blobId: 5 }] } } });
	assert.equal(responseName, "Email/set", JSON.stringify(result));
	assert.ok(result.created.x, `the draft should be created, got ${JSON.stringify(result)}`);
});

test("one bad call does not poison a good call in the same request", async (t) => {
	const [[errorName, error], [getName, get]] = await invoke(t, [
		["Email/query", { sort: "x" }, "bad"],
		["Mailbox/get", {}, "good"],
	]);
	assert.equal(errorName, "error");
	assert.equal(error.type, "invalidArguments");
	assert.equal(getName, "Mailbox/get");
	assert.ok(Array.isArray(get.list));
});

test("a bad create record does not stop a good one in the same call", async (t) => {
	const [responseName, result] = await single(t, "Mailbox/set", {
		create: { bad: null, good: { name: "Projects", parentId: "mb1" } },
	});
	assert.equal(responseName, "Mailbox/set", JSON.stringify(result));
	assert.equal(result.notCreated.bad.type, "invalidProperties");
	assert.ok(result.created.good, `good record should be created: ${JSON.stringify(result)}`);
});

test("valid create, update and destroy still work", async (t) => {
	const { env, db } = await newDatabase(t, SEED);
	const ctx = context(db, env);
	const response = await app.processRequest(ctx, {
		using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
		methodCalls: [
			["Mailbox/set", { create: { f1: { name: "Projects", parentId: "mb1" } } }, "c1"],
			["Mailbox/set", { update: { "mb1~f~fld1": { name: "Renamed" } }, destroy: ["mb1~f~fld1"] }, "c2"],
			["Email/set", { update: { "m-1": { "keywords/$seen": true } }, destroy: [] }, "c3"],
		],
	});
	const [[, created], [, updated], [, email]] = response.methodResponses;
	assert.ok(created.created.f1, JSON.stringify(created));
	assert.deepEqual(updated.updated, { "mb1~f~fld1": null });
	assert.deepEqual(updated.destroyed, ["mb1~f~fld1"]);
	assert.deepEqual(email.updated, { "m-1": null });
	assert.deepEqual(email.destroyed, []);
});

test("valid sort and nested filter operators still work", async (t) => {
	const [responseName, result] = await single(t, "Email/query", {
		sort: [{ property: "receivedAt", isAscending: true }, { property: "subject" }],
		filter: {
			operator: "AND",
			conditions: [{ inMailbox: "mb1~inbox" }, { operator: "OR", conditions: [{ from: "a@x.test" }, { subject: "nope" }] }],
		},
	});
	assert.equal(responseName, "Email/query", JSON.stringify(result));
	assert.deepEqual(result.ids, ["m-1"]);
});

test("absent and null args keep their current meaning", async (t) => {
	// An empty filter condition still matches everything (RFC 8621 §4.4.1).
	const [queryName, query] = await single(t, "Email/query", { filter: {} });
	assert.equal(queryName, "Email/query");
	assert.deepEqual(query.ids, ["m-1"]);
	// A null destroy list and null create/update maps are legal no-ops.
	const [setName, set] = await single(t, "Email/set", { create: null, update: null, destroy: null });
	assert.equal(setName, "Email/set");
	assert.deepEqual(set.destroyed, []);
});

// A method-level error must be answered before any write commits (RFC 8620
// §3.6.2): arg validation runs before the create/update loops, so a rejected
// call leaves no rows behind and records no #creation-id mappings.
test("Mailbox/set invalidArguments commits no create before it", async (t) => {
	for (const destroy of [5, "x"]) {
		const { env, db, sqlite } = await newDatabase(t, SEED);
		const response = await app.processRequest(context(db, env), {
			using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
			methodCalls: [
				["Mailbox/set", { create: { good: { name: "Projects", parentId: "mb1" } }, destroy }, "set"],
				["Mailbox/get", { ids: ["#good"] }, "get"],
				["Mailbox/query", { filter: { name: "Projects" } }, "query"],
			],
		});
		const [[setName, setResult], [getName, get], [queryName, query]] = response.methodResponses;
		assert.equal(setName, "error");
		assert.equal(setResult.type, "invalidArguments", `destroy=${JSON.stringify(destroy)}`);
		assert.equal(getName, "Mailbox/get");
		assert.deepEqual(get.notFound, ["#good"], "the failed call must not record a #good creation id");
		assert.equal(queryName, "Mailbox/query");
		assert.deepEqual(query.ids, []);
		assert.equal(sqlite.prepare("SELECT count(*) AS n FROM folders WHERE name = 'Projects'").get().n, 0);
	}
});

test("Email/set invalidArguments commits no update before it", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, SEED);
	const response = await app.processRequest(context(db, env), {
		using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
		methodCalls: [
			["Email/set", { update: { "m-1": { "keywords/$seen": true } }, destroy: 5 }, "set"],
			["Email/get", { ids: ["m-1"], properties: ["keywords"] }, "get"],
		],
	});
	const [[setName, setResult], [getName, get]] = response.methodResponses;
	assert.equal(setName, "error");
	assert.equal(setResult.type, "invalidArguments");
	assert.equal(getName, "Email/get");
	assert.deepEqual(get.list[0].keywords, {}, "the failed call must not have set $seen");
	assert.equal(sqlite.prepare("SELECT read FROM messages WHERE id = 'm-1'").get().read, 0);
});

test("mixed destroy lists destroy the valid ids and report the malformed ones", async (t) => {
	const [responseName, result] = await single(t, "Email/set", { destroy: ["m-1", {}, ["x"], 5, "m-missing"] });
	assert.equal(responseName, "Email/set", JSON.stringify(result));
	assert.deepEqual(result.destroyed, ["m-1"]);
	// Malformed ids are keyed by a position surrogate, never by toString coercion.
	for (const key of [malformedKey(1), malformedKey(2), malformedKey(3), "m-missing"]) {
		assert.equal(result.notDestroyed[key]?.type, "notFound", `notDestroyed[${key}]: ${JSON.stringify(result.notDestroyed)}`);
	}
});

// Mailbox/set checks the update patch's shape before folder existence and
// before the shared-mailbox ACL: the update path never SELECTs the folder (a
// missing folder with a well-formed patch is a silent no-op update), and the
// permission gate needs the patch's keys, so a null patch cannot be classified
// against either. The documented answer is invalidProperties — the same as
// Email/set reports for a bad patch on an existing row.
test("Mailbox/set answers a malformed patch before existence or ACL checks", async (t) => {
	const missing = await expectSetError(t, "Mailbox/set", { update: { "mb1~f~missing": null } }, "notUpdated", "mb1~f~missing");
	assert.equal(missing.type, "invalidProperties");

	const { env, db } = await newDatabase(t, `${sharedMailboxSeed("read_only")}
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-team', 'admin', 'mb-team', 'Theirs', 1);
	`);
	const delegate = {
		env, db, accountId: "acct", origin: "http://localhost", createdIds: {}, memo: undefined,
		auth: { userId: "delegate", user: { id: "delegate", email: "delegate@example.com", role: "user" }, scopes: ["jmap"], mailboxIds: null },
	};
	const response = await app.processRequest(delegate, {
		using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
		methodCalls: [["Mailbox/set", { update: { "mb-team~f~fld-team": null } }, "c"]],
	});
	const [[responseName, result]] = response.methodResponses;
	assert.equal(responseName, "Mailbox/set", JSON.stringify(result));
	assert.equal(result.notUpdated["mb-team~f~fld-team"].type, "invalidProperties");
});

// A destroy item like {"toString":5} broke record-key coercion inside the
// notDestroyed map — a TypeError the per-call catch-all answered as
// serverFail, and in a mixed list it landed AFTER the valid id was already
// destroyed (RFC 8620 §3.6.2 again). Response keys are now normalised before
// any write: the literal-string namespace is reserved for real ids, and every
// malformed item gets a positional surrogate allocated outside it — carrying
// no client content — so no input can forge or collide a key.
const HOSTILE = { toString: 5 };
const malformedKey = (index) => `malformed#${index}`;

test("a hostile destroy item answers a per-record error, not serverFail", async (t) => {
	for (const name of ["Mailbox/set", "Email/set"]) {
		const [responseName, result] = await single(t, name, { destroy: [HOSTILE] });
		assert.equal(responseName, name, JSON.stringify(result));
		assert.equal(result.notDestroyed[malformedKey(0)]?.type, "notFound", `${name}: ${JSON.stringify(result.notDestroyed)}`);
	}
	// Identity/set and EmailSubmission/set answer forbidden for every destroy
	// id by design — the hostile key gets the same verdict, not a throw.
	for (const name of ["Identity/set", "EmailSubmission/set"]) {
		const [responseName, result] = await single(t, name, { destroy: [HOSTILE] });
		assert.equal(responseName, name, JSON.stringify(result));
		assert.equal(result.notDestroyed[malformedKey(0)]?.type, "forbidden", `${name}: ${JSON.stringify(result.notDestroyed)}`);
	}
});

test("a literal string equal to a surrogate cannot steal a malformed item's key", async (t) => {
	// "malformed#0" is the allocator's first candidate for position 0 and
	// "malformed#0=5" an earlier surrogate format: both literals keep their own
	// entries, and 5 must be pushed to a free positional surrogate instead of
	// merging onto either.
	const [responseName, result] = await single(t, "Email/set", { destroy: [5, "malformed#0", "malformed#0=5"] });
	assert.equal(responseName, "Email/set", JSON.stringify(result));
	const keys = Object.keys(result.notDestroyed ?? {});
	assert.strictEqual(keys.length, 3, `expected 3 distinct keys, got ${JSON.stringify(keys)}`);
	assert.equal(result.notDestroyed["malformed#0"]?.type, "notFound");
	assert.equal(result.notDestroyed["malformed#0=5"]?.type, "notFound");
	assert.equal(result.notDestroyed["malformed#1"]?.type, "notFound");
});

test("a malformed destroy item's key echoes no client content", async (t) => {
	const [responseName, result] = await single(t, "Email/set", { destroy: [{ note: "fixture-marker" }] });
	assert.equal(responseName, "Email/set", JSON.stringify(result));
	assert.equal(result.notDestroyed["malformed#0"]?.type, "notFound", JSON.stringify(result.notDestroyed));
	for (const key of Object.keys(result.notDestroyed)) assert.ok(!key.includes("fixture-marker"), `key ${key} echoes client content`);
});

test("destroy items can never collide on a notDestroyed key", async (t) => {
	const destroy = [5, "5", ["5"], '["5"]', { a: 1 }, '{"a":1}', null, "null", "__proto__", "constructor", "malformed#0"];
	const [responseName, result] = await single(t, "Email/set", { destroy });
	assert.equal(responseName, "Email/set", JSON.stringify(result));
	const keys = Object.keys(result.notDestroyed ?? {});
	// Every item lands its own entry: literals stay themselves, malformed items
	// get surrogates, and __proto__/constructor survive as own properties.
	assert.strictEqual(keys.length, destroy.length, `expected ${destroy.length} keys, got ${JSON.stringify(keys)}`);
	for (const literal of ["5", '["5"]', '{"a":1}', "null", "__proto__", "constructor", "malformed#0"]) {
		assert.equal(result.notDestroyed[literal]?.type, "notFound", `literal ${literal}: ${JSON.stringify(result.notDestroyed)}`);
	}
	// "malformed#0" is reserved by the literal at index 10, so 5 skips to #1.
	for (const surrogate of [malformedKey(1), malformedKey(2), malformedKey(4), malformedKey(6)]) {
		assert.equal(result.notDestroyed[surrogate]?.type, "notFound", `surrogate ${surrogate}`);
	}
});

test("a hostile destroy item after a valid id cannot throw past the write", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, SEED);
	const response = await app.processRequest(context(db, env), {
		using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
		methodCalls: [["Email/set", { destroy: ["m-1", HOSTILE] }, "set"]],
	});
	const [[responseName, result]] = response.methodResponses;
	assert.equal(responseName, "Email/set", JSON.stringify(result));
	assert.deepEqual(result.destroyed, ["m-1"]);
	assert.equal(result.notDestroyed[malformedKey(1)]?.type, "notFound");
	assert.equal(sqlite.prepare("SELECT status FROM messages WHERE id = 'm-1'").get().status, "trash");
});

test("a hostile destroy item cannot throw past a committed Mailbox create", async (t) => {
	const [responseName, result] = await single(t, "Mailbox/set", {
		create: { good: { name: "Projects", parentId: "mb1" } },
		destroy: [HOSTILE],
	});
	assert.equal(responseName, "Mailbox/set", JSON.stringify(result));
	assert.ok(result.created.good, `the valid create should land: ${JSON.stringify(result)}`);
	assert.equal(result.notDestroyed[malformedKey(0)]?.type, "notFound");
});

test("hostile values inside a create record are per-record errors", async (t) => {
	// String(value.emailId) used to throw mid-loop in EmailSubmission/set.
	const submission = await expectSetError(t, "EmailSubmission/set", { create: { x: { emailId: HOSTILE } } }, "notCreated", "x");
	assert.equal(submission.type, "invalidProperties", JSON.stringify(submission));

	// Recipient/reference fields in Email/set create map straight into
	// insertDraft; a hostile item must not throw past earlier creations.
	const base = { mailboxIds: { "mb1~drafts": true }, from: [{ email: "kevin@example.com" }] };
	for (const [field, value] of [
		["to", [HOSTILE]],
		["to", [{ email: HOSTILE }]],
		["to", [{ email: "a@b.c", name: HOSTILE }]],
		["to", [null]],
		["cc", [{ email: HOSTILE }]],
		["bcc", [{ email: HOSTILE }]],
		["references", [HOSTILE]],
		["inReplyTo", [HOSTILE]],
	]) {
		const error = await expectSetError(t, "Email/set", { create: { x: { ...base, [field]: value } } }, "notCreated", "x");
		assert.equal(error.type, "invalidProperties", `${field}=${JSON.stringify(value)}`);
		assert.deepEqual(error.properties, [field]);
	}
});

test("hostile numeric and anchor args cannot throw", async (t) => {
	// NaN-path args degrade like any other unusable number: the call answers.
	for (const args of [{ limit: HOSTILE }, { position: HOSTILE }, { anchor: "m-1", anchorOffset: HOSTILE }]) {
		const [responseName, result] = await single(t, "Email/query", args);
		assert.equal(responseName, "Email/query", `${JSON.stringify(args)} -> ${JSON.stringify(result)}`);
	}
	const [getName, get] = await single(t, "Email/get", { ids: ["m-1"], maxBodyValueBytes: HOSTILE });
	assert.equal(getName, "Email/get");
	assert.equal(get.list.length, 1);
	const [queryName] = await single(t, "Mailbox/query", { limit: HOSTILE });
	assert.equal(queryName, "Mailbox/query");
	// A non-string anchor is a malformed Id, so it is invalidArguments.
	const error = await expectError(t, "Email/query", { anchor: HOSTILE });
	assert.equal(error.type, "invalidArguments");
});

test("hostile filter internals are invalidArguments, not serverFail", async (t) => {
	for (const filter of [
		{ header: ["references", HOSTILE] },
		{ operator: HOSTILE, conditions: [{}] },
	]) {
		const error = await expectError(t, "Email/query", { filter });
		assert.equal(error.type, "invalidArguments", `filter=${JSON.stringify(filter)}`);
	}
});

// EmailAddress.name is String|null per RFC 8621 §4.1.2.3 — the shape guard must
// not reject a null that the formatter already handles.
test("a null recipient name still creates the draft", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, SEED);
	const response = await app.processRequest(context(db, env), {
		using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
		methodCalls: [
			["Email/set", {
				create: {
					x: {
						mailboxIds: { "mb1~drafts": true },
						from: [{ email: "kevin@example.com", name: null }],
						to: [{ email: "a@x.test", name: null }],
						cc: [{ email: "b@x.test", name: null }],
						bcc: [{ email: "c@x.test", name: null }],
						subject: "null names",
					},
				},
			}, "set"],
		],
	});
	const [[responseName, result]] = response.methodResponses;
	assert.equal(responseName, "Email/set", JSON.stringify(result));
	assert.ok(result.created?.x, `expected the draft to be created: ${JSON.stringify(result)}`);
	const row = sqlite.prepare("SELECT to_addr, cc_addr, bcc_addr FROM messages WHERE subject = 'null names'").get();
	assert.deepEqual(row, { to_addr: "a@x.test", cc_addr: "b@x.test", bcc_addr: "c@x.test" });
});

test("a hostile comparator property is invalidArguments, not serverFail", async (t) => {
	const error = await expectError(t, "Email/query", { sort: [{ property: HOSTILE, isAscending: true }] });
	assert.equal(error.type, "invalidArguments");
});

// A "#ref" must resolve to an id this request actually created: reading
// ctx.createdIds off the prototype chain used to substitute Object.prototype
// .constructor — a Function — into the draft lookup, which threw a bind error
// after the first submission's send and draft delete had already committed.
test("an emailId of 'constructor' is a per-record error, not a post-send serverFail", async (t) => {
	const { env, db, sqlite } = await newSendDb(t, `${SEED}
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, read, private_draft, created_at) VALUES
			('draft-1', 'u1', 'mb1', 'outbound', 'kevin@example.com', 'a@x.test', 'Draft', 'draft', 1, 0, 2);
	`);
	const response = await sendApp.processRequest(context(db, env), {
		using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
		methodCalls: [["EmailSubmission/set", {
			create: {
				good: { emailId: "draft-1", identityId: "mb1~kevin@example.com" },
				bad: { emailId: "constructor", identityId: "mb1~kevin@example.com" },
			},
		}, "set"]],
	});
	const [[responseName, result]] = response.methodResponses;
	assert.equal(responseName, "EmailSubmission/set", JSON.stringify(result));
	assert.equal(result.created?.good?.id, "sent-x", `the first submission must succeed: ${JSON.stringify(result)}`);
	assert.equal(result.notCreated?.bad?.type, "invalidProperties", `expected a per-record error: ${JSON.stringify(result)}`);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM messages WHERE id = 'draft-1'").get().n, 0, "the submitted draft stays deleted");
});

// The allocator reserves literals first, then walks a monotonic cursor: a
// long literal run reserving the sequential prefix must not rescind earlier
// items or rescind the pass into quadratic probing.
test("the surrogate allocator stays linear on an adversarial reserved prefix", async (t) => {
	const k = 40;
	const destroy = [...Array.from({ length: k }, (_, index) => index), ...Array.from({ length: k }, (_, index) => malformedKey(index))];
	const [responseName, result] = await single(t, "Email/set", { destroy });
	assert.equal(responseName, "Email/set", JSON.stringify(result).slice(0, 400));
	assert.strictEqual(Object.keys(result.notDestroyed ?? {}).length, destroy.length);
	// Items 0..k-1 are malformed and the literals reserved malformed#0..k-1,
	// so the malformed items must land on malformed#k..malformed#(2k-1).
	for (let index = 0; index < k; index += 1) {
		assert.equal(result.notDestroyed[malformedKey(k + index)]?.type, "notFound", `item ${index} -> ${malformedKey(k + index)}`);
	}
});
