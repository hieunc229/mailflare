import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Cookie-authenticated mutations must refuse same-site cross-origin requests (hasValidSessionMutationOrigin).
const routes = {
	"src/app/api/backups/restore/route.ts": ["POST"],
	"src/app/api/backups/route.ts": ["PUT", "POST"],
	"src/app/api/backups/[id]/route.ts": ["DELETE"],
	"src/app/api/accounts/route.ts": ["POST", "DELETE"],
	"src/app/api/accounts/[id]/route.ts": ["PATCH"],
	"src/app/api/accounts/[id]/restore/route.ts": ["POST"],
	"src/app/api/mailboxes/[id]/route.ts": ["PATCH", "DELETE"],
	"src/app/api/admin/update/POST.ts": ["POST"],
	"src/app/api/admin/search-index/route.ts": ["POST"],
	"src/app/api/settings/profile/route.ts": ["PATCH"],
	"src/app/api/settings/forwarding/route.ts": ["PATCH"],
};

function handlerBody(source, method) {
	const start = source.indexOf(`export async function ${method}(`);
	assert.notEqual(start, -1, `${method} handler exists`);
	const next = source.indexOf("\nexport ", start + 1);
	return source.slice(start, next === -1 ? undefined : next);
}

for (const [file, methods] of Object.entries(routes)) {
	for (const method of methods) {
		test(`${method} ${file} checks the request origin`, () => {
			const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
			assert.match(handlerBody(source, method), /hasValidSessionMutationOrigin\(request\)/);
		});
	}
}
