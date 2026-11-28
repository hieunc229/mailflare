import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { localDateForSlot } = await loadComponent("src/app/book/[userId]/[eventId]/utils.ts");

test("localDateForSlot returns the zone-local date", () => {
	const slot = { startsAt: "2026-03-01T23:30:00Z" };
	assert.equal(localDateForSlot(slot, "Asia/Tokyo"), "2026-03-02");
	assert.equal(localDateForSlot(slot, "America/Los_Angeles"), "2026-03-01");
	assert.equal(localDateForSlot(slot, "Asia/Tokyo"), "2026-03-02");
});
