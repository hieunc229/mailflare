import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/app/(calendar)/calendar/page.tsx", import.meta.url), "utf8");

test("the editor reads who is signed in from the shared current-user hook", () => {
	assert.match(page, /import \{ useCurrentUser \} from "@\/hooks\/use-current-user";/);
	assert.match(page, /const currentUser = useCurrentUser\(\);/);
});

test("the event editor shows availability under the guests, never for a delegate (who cannot invite), and a picked time fills both fields", () => {
	assert.match(page, /import \{ AvailabilityPanel \} from "\.\/availability-panel";/);
	const mount = page.match(/\{!delegate && <div[^>]*>\s*<div \/>\s*<AvailabilityPanel guests=\{guests\} excludeEventId=\{editing\?\.id\} selfAddress=\{currentUser\?\.email\} startsAt=\{startsAt\} endsAt=\{endsAt\} onPick=\{\(start, end\) => \{ setStartsAt\(formatLocalDateTime\(start\)\); setEndsAt\(formatLocalDateTime\(end\)\); \}\} \/>\s*<\/div>\}/);
	assert.ok(mount, "mounted once, behind !delegate, with the picked slot written to both fields");
	assert.ok(page.indexOf("AvailabilityPanel guests") > page.indexOf('aria-label={t("calendar.guestsLabel")}'), "after the guests field");
	assert.ok(page.indexOf("AvailabilityPanel guests") < page.indexOf('aria-label={t("calendar.location")}'), "before the location field");
});
