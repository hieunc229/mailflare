import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(file, "utf8");

test("settings helpers use the user zone and the translator", () => {
	assert.doesNotMatch(read("src/app/(admin)/accounts/utils.ts"), /Intl\.DateTimeFormat\(undefined/);
	for (const file of ["src/components/settings/import-jobs.tsx", "src/components/settings/passkey-settings.tsx"]) {
		assert.doesNotMatch(read(file), /\.toLocale(Date)?String\(\)/, file);
	}
	assert.doesNotMatch(read("src/components/settings/mailbox-auto-reply-form.tsx"), /\?\? "Out of office"/);
	assert.doesNotMatch(read("src/app/(admin)/domains/ResendDomainSection.tsx"), /"Request failed"/);
});
