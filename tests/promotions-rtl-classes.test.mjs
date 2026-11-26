import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Physical direction classes break right-to-left layouts (Arabic, Persian, Urdu); use start/end utilities.
const PHYSICAL = /(?:^|[\s"'`:])(?:-?(?:ml|mr|pl|pr|left|right)-[\d\[]|text-(?:left|right)|float-(?:left|right)|rounded-(?:l|r|tl|tr|bl|br)(?:-|\b)|border-(?:l|r)(?:-|\b))/;

test("the Promotions and Subscriptions components use logical start/end classes", () => {
	for (const path of [
		"src/components/subscriptions/subscriptions-page.tsx",
		"src/components/subscriptions/subscription-parts.tsx",
		"src/components/settings/promotions-settings.tsx",
		"src/components/messages/promotion-toast.tsx",
	]) assert.doesNotMatch(read(path), PHYSICAL, path);
});

test("the Promotion chip in the message list uses a logical margin", () => {
	const chip = read("src/components/messages/message-folder-page.tsx").split("\n").find((line) => line.includes('t("promotions.chip")'));
	assert.ok(chip);
	assert.doesNotMatch(chip, PHYSICAL);
});
