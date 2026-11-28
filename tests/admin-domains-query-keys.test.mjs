import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const keyBeforeDomainsFetch = (file) =>
	readFileSync(file, "utf8").match(/queryKey:\s*(\[[^\]]*\]),\s*queryFn:\s*async \(\) => \{\s*const res = await authFetch\("\/api\/domains[?"]/)?.[1];

test("domains and mailboxes pages use different query keys", () => {
	const domains = keyBeforeDomainsFetch("src/app/(admin)/domains/page.tsx");
	const mailboxes = keyBeforeDomainsFetch("src/app/(admin)/mailboxes/page.tsx");
	assert.ok(domains && mailboxes, "both keys found");
	assert.notEqual(domains, mailboxes);
	assert.ok(mailboxes.startsWith('["domains"'));
});
