import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({ name: "cal-avail-utils", entryPoint: "src/app/(calendar)/calendar/availability-utils.ts", mocks: {} });
const { parseGuestAddresses, availabilityWindow, busyBlocks, overlapsAny, findFreeSlots, MAX_GUESTS } = await fixture.import();
after(() => fixture.dispose());

const H = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const D = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);

test("parseGuestAddresses reads a comma, semicolon or space separated list: trimmed, lower-cased, valid, each once", () => {
	assert.deepEqual(parseGuestAddresses(" Ann@One.test, bob@one.test;  ann@one.test  carol@x.org ,, not-an-address, @bad.test, a@b").addresses, ["ann@one.test", "bob@one.test", "carol@x.org"]);
	assert.deepEqual(parseGuestAddresses("").addresses, []);
	assert.equal(parseGuestAddresses("a@b.co").truncated, false);
});

test("parseGuestAddresses keeps the first 50 and says it cut the rest", () => {
	const text = Array.from({ length: 60 }, (_, index) => `p${index}@one.test`).join(",");
	const result = parseGuestAddresses(text);
	assert.equal(MAX_GUESTS, 50);
	assert.equal(result.addresses.length, 50);
	assert.equal(result.addresses[49], "p49@one.test");
	assert.equal(result.truncated, true);
});

test("availabilityWindow is the day of the event, a day either side, in the person's zone", () => {
	const window = availabilityWindow(new Date(D(2030, 1, 9, 15)), "UTC");
	assert.equal(iso(window.dayStart.getTime()), "2030-01-09T00:00:00.000Z");
	assert.equal(iso(window.dayEnd.getTime()), "2030-01-10T00:00:00.000Z");
	assert.equal(iso(window.from.getTime()), "2030-01-08T00:00:00.000Z");
	assert.equal(iso(window.to.getTime()), "2030-01-11T00:00:00.000Z");
	const ny = availabilityWindow(new Date(D(2030, 1, 9, 3)), "America/New_York");
	assert.equal(iso(ny.dayStart.getTime()), "2030-01-08T05:00:00.000Z", "03:00 UTC is still the 8th in New York");
});

test("busyBlocks places intervals on the day as percentages, clamps to it and drops the ones outside", () => {
	const dayStart = new Date(D(2030, 1, 9));
	const dayEnd = new Date(D(2030, 1, 10));
	const blocks = busyBlocks([[iso(D(2030, 1, 9, 6)), iso(D(2030, 1, 9, 12))], [iso(D(2030, 1, 9, 22)), iso(D(2030, 1, 10, 2))], [iso(D(2030, 1, 8, 1)), iso(D(2030, 1, 8, 2))], [iso(D(2030, 1, 10, 1)), iso(D(2030, 1, 10, 2))], ["bad", "worse"]], dayStart, dayEnd);
	assert.deepEqual(blocks.map((block) => [block.left, block.width]), [[25, 25], [(22 / 24) * 100, (2 / 24) * 100]]);
	assert.equal(iso(blocks[1].to.getTime()), "2030-01-10T00:00:00.000Z", "clamped for display");
});

test("overlapsAny: touching is not overlapping", () => {
	const busy = [[iso(D(2030, 1, 9, 9)), iso(D(2030, 1, 9, 10))]];
	assert.equal(overlapsAny(busy, new Date(D(2030, 1, 9, 9, 30)), new Date(D(2030, 1, 9, 11))), true);
	assert.equal(overlapsAny(busy, new Date(D(2030, 1, 9, 10)), new Date(D(2030, 1, 9, 11))), false);
	assert.equal(overlapsAny(busy, new Date(D(2030, 1, 9, 8)), new Date(D(2030, 1, 9, 9))), false);
	assert.equal(overlapsAny([], new Date(0), new Date(H)), false);
});

const find = (options) => findFreeSlots({ now: new Date(D(2030, 1, 9, 7)), zone: "UTC", durationMs: H, busyByPerson: [], ...options });
const starts = (slots) => slots.map((slot) => iso(slot.start.getTime()));

test("findFreeSlots offers the next three free slots inside 08:00-18:00, one after another, not overlapping", () => {
	assert.deepEqual(starts(find({})), ["2030-01-09T08:00:00.000Z", "2030-01-09T09:00:00.000Z", "2030-01-09T10:00:00.000Z"]);
});

test("findFreeSlots steps over everyone's busy time, and starts no earlier than now", () => {
	const person1 = [[iso(D(2030, 1, 9, 8)), iso(D(2030, 1, 9, 9, 30))]];
	const person2 = [[iso(D(2030, 1, 9, 9)), iso(D(2030, 1, 9, 11))]];
	assert.deepEqual(starts(find({ busyByPerson: [person1, person2] })), ["2030-01-09T11:00:00.000Z", "2030-01-09T12:00:00.000Z", "2030-01-09T13:00:00.000Z"]);
	assert.deepEqual(starts(find({ now: new Date(D(2030, 1, 9, 12, 10)) })), ["2030-01-09T12:30:00.000Z", "2030-01-09T13:30:00.000Z", "2030-01-09T14:30:00.000Z"]);
});

test("findFreeSlots never runs past 18:00 and moves on to the next day", () => {
	const busy = [[iso(D(2030, 1, 9, 8)), iso(D(2030, 1, 9, 16, 30))]];
	assert.deepEqual(starts(find({ busyByPerson: [busy], durationMs: 2 * H })), ["2030-01-10T08:00:00.000Z", "2030-01-10T10:00:00.000Z", "2030-01-10T12:00:00.000Z"]);
});

test("findFreeSlots works in the organiser's zone", () => {
	const slots = find({ zone: "America/New_York", now: new Date(D(2030, 1, 9, 0)) });
	assert.equal(starts(slots)[0], "2030-01-09T13:00:00.000Z", "08:00 in New York in January");
});

test("findFreeSlots looks 14 days ahead and no further, and answers nothing when the event is longer than the working day", () => {
	assert.deepEqual(find({ busyByPerson: [[[iso(D(2030, 1, 9)), iso(D(2030, 1, 23))]]] }), [], "free only on day 15, which is not offered");
	const lastDay = [[iso(D(2030, 1, 9)), iso(D(2030, 1, 22, 16, 30))]];
	assert.deepEqual(starts(find({ busyByPerson: [lastDay] })), ["2030-01-22T16:30:00.000Z"], "day 14 is the last one offered");
	assert.deepEqual(find({ durationMs: 11 * H }), []);
	assert.deepEqual(find({ durationMs: 0 }), []);
});
