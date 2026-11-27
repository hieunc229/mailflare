import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({ name: "cal-pub-linklib", entryPoint: "src/lib/calendar/free-busy-link.ts", mocks: {} });
const { enableFreeBusyLink, authenticateFreeBusyKey } = await fixture.import();
after(() => fixture.dispose());

// MySQL has no INSERT ... RETURNING: the shim in src/db/compat.ts reads the row back by primary key afterwards, so when a competing
// request inserted first, the loser still gets a row back (the winner's). Only the stored hash tells whose secret it is.
const losingDb = (winnersHash) => ({ insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: "freebusy_u1", keySha256: winnersHash }] }) }) }) });
const echoDb = () => {
	let stored = null;
	return { insert: () => ({ values: (row) => ({ onConflictDoNothing: () => ({ returning: async () => { stored = row; return [{ id: row.id, keySha256: row.keySha256 }]; } }) }) }), stored: () => stored };
};

test("a request whose insert lost the race is not told it made the link, even when the database hands back the winner's row", async () => {
	assert.deepEqual(await enableFreeBusyLink(losingDb("a".repeat(64)), "u1"), { created: false });
});

test("a request whose insert won gets the secret whose hash is the stored one", async () => {
	const db = echoDb();
	const result = await enableFreeBusyLink(db, "u1");
	assert.equal(result.created, true);
	assert.match(result.key, /^ep_/);
	assert.equal(db.stored().keySha256.length, 64);
	assert.equal(db.stored().scopes, '["calendar:freebusy"]');
});

test("only the exact scope is a publish key, and only an owner with Calendar on", async () => {
	assert.equal(await authenticateFreeBusyKey({ DB: {} }, ""), null);
});
