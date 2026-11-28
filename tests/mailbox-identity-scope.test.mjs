import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadApp } from "./helpers/real-db.mjs";

import {
	isPrimaryMailbox,
	resolveMailboxAvatarKey,
	resolveMailboxDisplayName,
	tracksAccountIdentity,
} from "../src/lib/profile/identity-utils.ts";

const { app, newDatabase } = await loadApp("mailbox-identity-scope", `
	export { syncPersonalIdentity } from "./src/lib/profile/sync.ts";
`);

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

test("renaming the profile leaves sibling mailboxes untouched (issue #36)", async (t) => {
	const { db, sqlite } = await newDatabase(t, `
		INSERT INTO users (id, email, password_hash, name, avatar_key, role, created_at) VALUES ('u1', 'sam@example.com', 'x', 'Sam Reyes', 'avatars/user-1', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'u1', 'example.com', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, avatar_key, type, created_at) VALUES
			('m1', 'u1', 'd1', 'sam', 'Sam Reyes', 'avatars/user-1', 'personal', 1),
			('m2', 'u1', 'd1', 'billing', 'Billing', 'avatars/mbx-2', 'personal', 1),
			('m3', 'u1', 'd1', 'projects', 'Projects', NULL, 'personal', 1);
	`);
	await app.syncPersonalIdentity(db, { userId: "u1", name: "Sam R. Reyes", avatarKey: "avatars/user-2" });

	const named = sqlite.prepare("SELECT id, display_name, avatar_key FROM mailboxes ORDER BY id").all().map((row) => ({ ...row }));
	assert.deepEqual(named, [
		{ id: "m1", display_name: "Sam R. Reyes", avatar_key: "avatars/user-2" },
		{ id: "m2", display_name: "Billing", avatar_key: "avatars/mbx-2" },
		{ id: "m3", display_name: "Projects", avatar_key: null },
	]);
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
