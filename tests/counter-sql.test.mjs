import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({ name: "counter-sql", entryPoint: "src/db/sql.ts", mocks: {} });
after(() => fixture.dispose());
const { counterIncrementSql } = await fixture.import();

test("the counter upsert follows the dialect", () => {
	assert.match(counterIncrementSql("mysql", "t"), /INSERT INTO t \(bucket, hits, expires_at\) VALUES \(\?, 1, \?\) ON DUPLICATE KEY UPDATE hits = hits \+ 1$/);
	const expected = "INSERT INTO t (bucket, hits, expires_at) VALUES (?, 1, ?) ON CONFLICT (bucket) DO UPDATE SET hits = t.hits + 1 RETURNING hits";
	assert.equal(counterIncrementSql("postgres", "t"), expected);
	assert.equal(counterIncrementSql("sqlite", "t"), expected);
});
