import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// getMailboxAccessLevel waits 10 ms and records how many calls overlap.
const { app, newDatabase } = await loadApp("mcp-auth-parallel", `export { authenticateMcpRequest } from "./src/lib/mcp/auth.ts";`, { mocks: {
	"@/lib/api/find-api-key": `export const findApiKeyForSecret = async () => ({ id: "k1", userId: "delegate", scopes: JSON.stringify(["mcp:read"]) });`,
	"@/lib/mailboxes/access": `
		export async function getMailboxAccessLevel(_db, _user, id) {
			const state = globalThis.__mcpAuth;
			state.inFlight += 1;
			state.peak = Math.max(state.peak, state.inFlight);
			await new Promise((resolve) => setTimeout(resolve, 10));
			state.inFlight -= 1;
			return { canRead: id !== "mb-denied" };
		}
	`,
} });

test("mailbox checks run in parallel and keep the key's order", async (t) => {
	const { env } = await newDatabase(t, `${sharedMailboxSeed("full_access")}
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('mb-1', 'delegate', 'domain-1', 'one', 'personal', 1), ('mb-2', 'delegate', 'domain-1', 'two', 'personal', 1),
			('mb-denied', 'delegate', 'domain-1', 'denied', 'personal', 1), ('mb-3', 'delegate', 'domain-1', 'three', 'personal', 1);
		INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, created_at) VALUES ('k1', 'mcp', 'delegate', 'key', 'ep_test', 'x', '["mcp:read"]', 1);
		INSERT INTO mcp_key_mailboxes (key_id, mailbox_id) VALUES ('k1', 'mb-1'), ('k1', 'mb-2'), ('k1', 'mb-denied'), ('k1', 'mb-3');`);
	globalThis.__mcpAuth = { inFlight: 0, peak: 0 };
	const principal = await app.authenticateMcpRequest(env, new Request("http://x", { headers: { Authorization: "Bearer ep_test" } }));
	assert.deepEqual(principal.mailboxIds, ["mb-1", "mb-2", "mb-3"]);
	assert.ok(globalThis.__mcpAuth.peak > 1, `max in-flight ${globalThis.__mcpAuth.peak}`);
});
