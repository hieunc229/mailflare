import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("contacts-seen-like", `export { addressesSeenInMailbox } from "./src/app/api/contacts/utils.ts";`);

test("an address containing a LIKE wildcard is matched literally", async (t) => {
	const { db } = await newDatabase(t, `${sharedMailboxSeed("read_only")}
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES
			('m-1', 'admin', 'mb-team', 'outbound', 'team@example.com', 'a%b@example.net, c_d@example.net', 'Hi', 'sent', 1);`);
	// One address per call: the candidate rows are shared by a chunk, so a neighbour could mask a missed match.
	for (const email of ["a%b@example.net", "c_d@example.net"]) {
		assert.deepEqual([...await app.addressesSeenInMailbox(db, "mb-team", [email], "delegate")], [email]);
	}
	assert.equal((await app.addressesSeenInMailbox(db, "mb-team", ["axb@example.net"], "delegate")).size, 0);
});
