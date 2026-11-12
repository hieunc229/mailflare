import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/lib/calendar/invite-store.ts"), "utf8");

// The database query cannot run in these tests, so this pins the part that matters: the fallback zone is read only
// from events the user made, never from invitation rows (whose zone is chosen by the sender).
test("the recipient zone fallback ignores events created from invitations", () => {
	const start = source.indexOf("export async function recipientInviteTimeZone");
	assert.ok(start > 0, "function found");
	const body = source.slice(start, source.indexOf("\n}\n", start));
	assert.match(body, /isNull\(calendarEvents\.inviteMessageId\)/);
	assert.match(body, /isNull\(calendarEvents\.responseStatus\)/);
});
