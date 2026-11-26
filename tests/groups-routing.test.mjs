import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("groups-routing", `export { ensureGroupDomainRouting } from "./src/lib/groups/routing.ts";`, {
	mocks: {
		"@/lib/cloudflare-api": "export async function ensureEmailRoutingRuleToWorker(env,zone,address){if(globalThis.gr.fail===address)throw new Error('boom');globalThis.gr.ensured.push([zone,address])}",
	},
});

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('admin', 'admin@example.com', 'h', 'Admin', 'admin', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'admin', 'example.com', 'z1', 'active', 1), ('d2', 'admin', 'other.com', 'z2', 'active', 1);
	INSERT INTO mail_groups (id, domain_id, local_part, name, disabled, created_at, updated_at) VALUES
		('g1', 'd1', 'team', 'Team', 0, 1, 1), ('g2', 'd1', 'sales', 'Sales', 1, 1, 1), ('g3', 'd2', 'info', 'Info', 0, 1, 1);
`;
const domain = { id: "d1", hostname: "example.com", zoneId: "z1" };

test("every group address of the domain gets its Worker route back, disabled groups included", async (t) => {
	const { env, db } = await newDatabase(t, seed);
	globalThis.gr = { ensured: [] };
	await app.ensureGroupDomainRouting(env, db, domain, new Map());
	assert.deepEqual(globalThis.gr.ensured.map(([, address]) => address).sort(), ["sales@example.com", "team@example.com"]);
	assert.ok(globalThis.gr.ensured.every(([zone]) => zone === "z1"));
});

test("one failing rule does not stop the others", async (t) => {
	const { env, db } = await newDatabase(t, seed);
	globalThis.gr = { ensured: [], fail: "sales@example.com" };
	await app.ensureGroupDomainRouting(env, db, domain, new Map());
	assert.deepEqual(globalThis.gr.ensured.map(([, address]) => address), ["team@example.com"]);
});

test("a database without the groups migration has nothing to restore", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, seed);
	sqlite.exec("DROP TABLE mail_group_members; DROP TABLE mail_groups");
	globalThis.gr = { ensured: [] };
	await app.ensureGroupDomainRouting(env, db, domain, new Map());
	assert.deepEqual(globalThis.gr.ensured, []);
});
