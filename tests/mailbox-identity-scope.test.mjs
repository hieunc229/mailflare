import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	isPrimaryMailbox,
	resolveMailboxAvatarKey,
	resolveMailboxDisplayName,
	tracksAccountIdentity,
} from "../src/lib/profile/identity-utils.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const ACCOUNT_EMAIL = "sam@example.com";
const primary = { localPart: "sam", hostname: "example.com", type: "personal", displayName: "Sam Reyes", avatarKey: "avatars/user-1" };
const secondary = { localPart: "billing", hostname: "example.com", type: "personal", displayName: "Billing", avatarKey: "avatars/mbx-2" };
const shared = { localPart: "support", hostname: "example.com", type: "shared", displayName: "Support", avatarKey: "avatars/mbx-3" };

test("only the mailbox at the account address carries the account identity", () => {
	assert.equal(isPrimaryMailbox(primary, ACCOUNT_EMAIL), true);
	assert.equal(isPrimaryMailbox(secondary, ACCOUNT_EMAIL), false);

	assert.equal(tracksAccountIdentity(primary, ACCOUNT_EMAIL), true);
	assert.equal(tracksAccountIdentity(secondary, ACCOUNT_EMAIL), false);
	assert.equal(tracksAccountIdentity(shared, ACCOUNT_EMAIL), false);
});

test("the address match ignores case and surrounding space", () => {
	assert.equal(isPrimaryMailbox({ localPart: "Sam", hostname: "Example.com" }, " SAM@example.com "), true);
	assert.equal(isPrimaryMailbox(primary, null), false);
	assert.equal(isPrimaryMailbox(primary, undefined), false);
});

test("a secondary mailbox resolves to its own name and avatar", () => {
	assert.equal(resolveMailboxDisplayName(primary, ACCOUNT_EMAIL, "Sam Reyes"), "Sam Reyes");
	assert.equal(resolveMailboxDisplayName(secondary, ACCOUNT_EMAIL, "Sam Reyes"), "Billing");
	assert.equal(resolveMailboxAvatarKey(primary, ACCOUNT_EMAIL, "avatars/user-1"), "avatars/user-1");
	assert.equal(resolveMailboxAvatarKey(secondary, ACCOUNT_EMAIL, "avatars/user-1"), "avatars/mbx-2");
});

test("renaming the profile leaves sibling mailboxes untouched (issue #36)", () => {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, avatar_key TEXT);
		CREATE TABLE domains (id TEXT PRIMARY KEY, hostname TEXT NOT NULL);
		CREATE TABLE mailboxes (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL, domain_id TEXT NOT NULL,
			local_part TEXT NOT NULL, display_name TEXT, avatar_key TEXT, type TEXT NOT NULL
		);
		INSERT INTO users VALUES ('u1', 'sam@example.com', 'Sam Reyes', 'avatars/user-1');
		INSERT INTO domains VALUES ('d1', 'example.com');
		INSERT INTO mailboxes VALUES
			('m1', 'u1', 'd1', 'sam', 'Sam Reyes', 'avatars/user-1', 'personal'),
			('m2', 'u1', 'd1', 'billing', 'Billing', 'avatars/mbx-2', 'personal'),
			('m3', 'u1', 'd1', 'projects', 'Projects', NULL, 'personal');
	`);

	// What syncPersonalIdentity does now: load every personal mailbox with its
	// hostname, then write only to the one that carries the account identity.
	const account = db.prepare("SELECT email FROM users WHERE id = ?").get("u1");
	const rows = db
		.prepare(`
			SELECT m.id, m.local_part, m.type, d.hostname
			FROM mailboxes m JOIN domains d ON d.id = m.domain_id
			WHERE m.user_id = ? AND m.type = 'personal'
		`)
		.all("u1");

	const identityRows = rows.filter((row) =>
		tracksAccountIdentity({ localPart: row.local_part, hostname: row.hostname, type: row.type }, account.email),
	);
	assert.deepEqual(identityRows.map((row) => row.id), ["m1"], "exactly one mailbox holds the account identity");

	for (const row of identityRows) {
		db.prepare("UPDATE mailboxes SET display_name = ?, avatar_key = ? WHERE id = ?")
			.run("Sam R. Reyes", "avatars/user-2", row.id);
	}

	const named = db
		.prepare("SELECT id, display_name, avatar_key FROM mailboxes ORDER BY id")
		.all()
		.map((row) => ({ ...row }));
	assert.deepEqual(named, [
		{ id: "m1", display_name: "Sam R. Reyes", avatar_key: "avatars/user-2" },
		{ id: "m2", display_name: "Billing", avatar_key: "avatars/mbx-2" },
		{ id: "m3", display_name: "Projects", avatar_key: null },
	]);
});

test("the identity write is keyed by mailbox id, not by owner and type", () => {
	const sync = read("src/lib/profile/sync.ts");
	const updates = [...sync.matchAll(/\.update\(mailboxes\)[\s\S]*?\.where\(([\s\S]*?)\);/g)].map((m) => m[1]);
	assert.ok(updates.length > 0, "no mailbox update found in syncPersonalIdentity");
	for (const where of updates) {
		assert.ok(
			/eq\(mailboxes\.id,/.test(where),
			`mailbox identity update must target a single mailbox id, got: ${where.trim()}`,
		);
		assert.ok(
			!/eq\(mailboxes\.type, "personal"\)/.test(where),
			"an update scoped by type fans the account name out to every personal mailbox",
		);
	}
	assert.match(sync, /tracksAccountIdentity/);
});

test("the mailbox routes gate the account name on the identity check", () => {
	const detail = read("src/app/api/mailboxes/[id]/route.ts");
	assert.match(detail, /tracksAccountIdentity\(existing, existing\.ownerEmail\) && "displayName" in parsed\.data/);
	assert.ok(
		!/existing\.type === "personal" && "displayName" in parsed\.data/.test(detail),
		"PATCH must not treat every personal mailbox as the account identity",
	);

	const list = read("src/app/api/mailboxes/route.ts");
	assert.match(list, /tracksAccountIdentity\(mailbox, user\.email\)/);
	assert.ok(
		!/mailbox\.type === "personal"\n?\s*\? \{ displayName: user\.name/.test(list),
		"the list response must not overwrite every personal mailbox name with the account name",
	);
});

test("outgoing mail and message lists use the mailbox's own name", () => {
	const sender = read("src/lib/email/sender.ts");
	assert.match(sender, /resolveMailboxDisplayName\(mailbox, mailbox\.ownerEmail, mailbox\.ownerName\)/);
	assert.ok(
		!/mailbox\.type === "personal" \? mailbox\.ownerName/.test(sender),
		"every personal mailbox would send under the account owner's name",
	);

	const messages = read("src/app/api/messages/route.ts");
	assert.match(messages, /tracksAccountIdentity\(mailbox, user\.email\)/);
});

test("the client only repaints the primary mailbox on profile changes", () => {
	const provider = read("src/components/mailbox-provider.tsx");
	assert.match(provider, /isIdentityMailbox\(mailbox\)/);
	assert.ok(
		!/mailbox\.type === "personal" \? \{ \.\.\.mailbox, displayName: name \}/.test(provider),
		"a profile rename must not relabel every personal mailbox in the sidebar",
	);

	const utils = read("src/components/mailbox-provider-utils.ts");
	assert.match(utils, /export function isIdentityMailbox/);
});
