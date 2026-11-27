import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({ name: "cal-pub-ifb", entryPoint: "src/lib/calendar/free-busy-publish.ts", mocks: { "@/db": "export function getDb(){return null}" } });
const { buildFreeBusyIcs, buildFreeBusyIfb } = await fixture.import();
after(() => fixture.dispose());
const DAY = 86_400_000;
const H = 3_600_000;

test("the .ifb is a VFREEBUSY with no METHOD: RFC 5546 asks for an ORGANIZER with PUBLISH, and none is given", () => {
	const body = buildFreeBusyIfb([], { uid: "k", now: new Date(0), start: new Date(0), end: new Date(DAY) });
	assert.doesNotMatch(body, /METHOD/);
	assert.doesNotMatch(body, /ORGANIZER/);
	assert.match(buildFreeBusyIcs([[0, H]], { uid: "k", now: new Date(0) }), /METHOD:PUBLISH/, "the subscription calendar of events keeps it");
});
