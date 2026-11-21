/**
 * Two users, their mailboxes, a team mailbox shared with the first, and helpers to
 * add app passwords and messages. Rows are inserted with plain SQL so a test sees
 * exactly what the IMAP code reads.
 */
export function seedWorld(sqlite) {
	sqlite.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u1', 'me@example.test', 'x', 'One', 'user', 1), ('u2', 'two@example.test', 'x', 'Two', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.test', 'z', 1), ('d2', 'u2', 'other.test', 'z2', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('m1', 'u1', 'd1', 'me', 'personal', 1),
			('m1b', 'u1', 'd1', 'second', 'personal', 1),
			('m2', 'u2', 'd2', 'two', 'personal', 1),
			('ms', 'u2', 'd2', 'team', 'shared', 1);
		INSERT INTO mailbox_aliases (id, mailbox_id, domain_id, local_part, created_at) VALUES ('al1', 'm1', 'd1', 'alias', 1);
		INSERT INTO license_settings (id, instance_id, plan, state, features, updated_at) VALUES ('default', 'i', 'team', 'active', '[]', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('ma1', 'ms', 'u1', 'read_only', 1);
	`);
}

export function makeHelpers(sqlite, generateAppPassword) {
	let counter = 0;
	let clock = 1_700_000_000;
	return {
		async addKey({ id, userId = "u1", kind = "app", scopes = ["imap"], mailboxes = null }) {
			const key = await generateAppPassword();
			sqlite
				.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, kind, scopes, mailbox_scope_enabled, created_at) VALUES (?, ?, 'k', ?, ?, ?, ?, ?, ?, 1)")
				.run(id, userId, key.prefix, key.hash, key.sha256, kind, JSON.stringify(scopes), mailboxes ? 1 : 0);
			for (const mailboxId of mailboxes ?? []) sqlite.prepare("INSERT INTO mcp_key_mailboxes (key_id, mailbox_id) VALUES (?, ?)").run(id, mailboxId);
			return key;
		},
		addMessage(overrides = {}) {
			const id = overrides.id ?? `g${++counter}`;
			const owner = overrides.mailbox_id ?? "m1";
			const row = { user_id: owner === "m2" || owner === "ms" ? "u2" : "u1", mailbox_id: owner, direction: "inbound", from_addr: "a@b.test", to_addr: "me@example.test", status: "received", subject: `subject ${id}`, text_body: `body of ${id}`, html_body: null, created_at: (clock += 60), ...overrides, id };
			const names = Object.keys(row);
			sqlite.prepare(`INSERT INTO messages (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(row));
			return id;
		},
	};
}
