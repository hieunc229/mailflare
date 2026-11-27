import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({ name: "booking-resource-ids", entryPoint: "src/lib/booking/resource-ids.ts", mocks: {} });
const { MAX_BOOKING_ROOMS, parseBookingResourceIds } = await fixture.import();
after(() => fixture.dispose());

test("a stored list is read back; anything unreadable is null, not an empty list", () => {
	assert.deepEqual(parseBookingResourceIds('["r1","r2"]'), ["r1", "r2"]);
	assert.deepEqual(parseBookingResourceIds("[]"), []);
	for (const bad of ["garbage", '["r1","r1"]', '[1]', '[""]', '{"0":"r1"}', '["a","b","c","d","e","f"]', "null", undefined]) assert.equal(parseBookingResourceIds(bad), null, String(bad));
});

test("the limit is the one an event save uses", () => {
	const source = readFileSync(new URL("../src/lib/calendar/resources.ts", import.meta.url), "utf8");
	assert.equal(MAX_BOOKING_ROOMS, Number(/MAX_EVENT_RESOURCES = (\d+)/.exec(source)[1]));
});
