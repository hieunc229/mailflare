import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const mocks = { "@/lib/auth/client": "export async function authFetch(){}", "@/lib/http/client-error": "export function requestError(){}" };
const fixture = await loadFixture({ name: "cal-pub-keyname", entryPoint: "src/components/settings/api-keys-settings-utils.ts", mocks });
const { keyDisplayName } = await fixture.import();
after(() => fixture.dispose());
const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
const t = (key) => `[${en[key] ?? key}]`;

test("the publish key is listed under a translated name, whatever name is stored; any other key keeps its own", () => {
	assert.equal(keyDisplayName({ id: "freebusy_u1", name: "Published free/busy" }, t), "[Published free/busy link]");
	assert.equal(keyDisplayName({ id: "key_abc", name: "My script" }, t), "My script");
	assert.equal(keyDisplayName({ id: "key_freebusy_x", name: "Mine" }, t), "Mine", "only the id format that the publish link makes counts");
});

test("the name is a string in every catalog", () => {
	assert.ok(en["calendar.publish.keyName"]);
});
