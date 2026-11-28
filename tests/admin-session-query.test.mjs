import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("domains and mailboxes use the shared session query", () => {
	for (const file of ["src/app/(admin)/domains/page.tsx", "src/app/(admin)/mailboxes/page.tsx"]) {
		const source = readFileSync(file, "utf8");
		assert.ok(source.includes('queryKey: ["session-info"]') && source.includes("fetchSessionInfo"), file);
		assert.ok(!source.includes('"/api/auth/me"'), file);
	}
	assert.ok(!readFileSync("src/app/(admin)/mailboxes/types.d.ts", "utf8").includes("CurrentAccountResponse"));
});

test("domain favicon is lazy and sends no referrer", () => {
	const source = readFileSync("src/app/(admin)/domains/DomainItemCard.tsx", "utf8");
	const img = source.slice(source.indexOf("favicon.ico") - 80, source.indexOf("/>", source.indexOf("favicon.ico")));
	assert.ok(img.includes('loading="lazy"') && img.includes('referrerPolicy="no-referrer"'));
});
