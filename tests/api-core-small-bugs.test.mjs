import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const session = {
	"next/server": "export const NextResponse = { json: (body, init) => Response.json(body, init) }",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/db": "export function getDb(){return {}}",
	"@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return true}",
	"@/lib/auth/cookies": `import { UnauthorizedError } from "@/lib/auth/unauthorized";
		export async function requireUser(){ const s = globalThis.smallBugs; if (s.throws === "unauthorized") throw new UnauthorizedError(); if (s.throws) throw new Error("boom"); return s.user }`,
};
const fixtures = [];
async function load(name, entryPoint, mocks) {
	const fixture = await loadFixture({ name: `small-bugs-${name}`, entryPoint, mocks: { ...session, ...mocks } });
	fixtures.push(fixture);
	return fixture.import();
}
after(() => {
	for (const fixture of fixtures) fixture.dispose();
	delete globalThis.smallBugs;
});
globalThis.smallBugs = { user: { id: "u1", role: "user" }, throws: null };

const post = (route, body) => route(new Request("https://mail.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body }), { params: Promise.resolve({ id: "m1" }) });

test("seed refuses without the opt-in flag", async () => {
	const { POST } = await load("seed", "src/app/api/seed/route.ts", {
		"@/lib/seed": "export async function seedDemoData(){return {}}",
		"@/lib/seed-utils": "export const demoCredentials = { email: 'demo@x.test' }",
	});
	const previous = { env: process.env.NODE_ENV, flag: process.env.MAILFLARE_DEMO_SEED };
	try {
		delete process.env.NODE_ENV;
		delete process.env.MAILFLARE_DEMO_SEED;
		assert.equal((await POST(new Request("https://mail.test/api/seed", { method: "POST" }))).status, 403);
		process.env.MAILFLARE_DEMO_SEED = "1";
		assert.equal((await POST(new Request("https://mail.test/api/seed", { method: "POST" }))).status, 200);
		process.env.NODE_ENV = "production";
		assert.equal((await POST(new Request("https://mail.test/api/seed", { method: "POST" }))).status, 403);
	} finally {
		for (const [key, value] of [["NODE_ENV", previous.env], ["MAILFLARE_DEMO_SEED", previous.flag]]) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
});

test("mailbox routes answer 400 on malformed JSON", async () => {
	const aliases = await load("aliases", "src/app/api/mailboxes/[id]/aliases/route.ts", {});
	const mailbox = await load("mailbox", "src/app/api/mailboxes/[id]/route.ts", {});
	assert.equal((await post(aliases.POST, "{")).status, 400);
	assert.equal((await aliases.PATCH(new Request("https://mail.test/x", { method: "PATCH", body: "{" }), { params: Promise.resolve({ id: "m1" }) })).status, 400);
	assert.equal((await mailbox.PATCH(new Request("https://mail.test/x", { method: "PATCH", body: "{" }), { params: Promise.resolve({ id: "m1" }) })).status, 400);
});

test("requireTeamAdmin answers 401 when signed out", async () => {
	const { requireTeamAdmin } = await load("team-admin", "src/app/api/accounts/utils.ts", {
		"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canManageAccounts:true}}",
	});
	const request = new Request("http://x");
	globalThis.smallBugs.throws = "unauthorized";
	assert.equal((await requireTeamAdmin(request)).error.status, 401);
	globalThis.smallBugs.throws = "other";
	assert.equal((await requireTeamAdmin(request)).error.status, 403);
	globalThis.smallBugs.throws = null;
	globalThis.smallBugs.user = { id: "u1", role: "user" };
	assert.equal((await requireTeamAdmin(request)).error.status, 403);
	globalThis.smallBugs.user = { id: "a1", role: "admin" };
	assert.equal((await requireTeamAdmin(request)).error, null);
});

test("avatar rule matches the account route", async () => {
	const { getManagedAccount } = await load("avatar", "src/app/api/accounts/[id]/avatar/utils.ts", {
		"../../utils": "export async function requireTeamAdmin(){ const s = globalThis.smallBugs; return { env: {}, user: s.actor, error: null } }",
		"../utils": "export async function selectAccountById(){ return globalThis.smallBugs.account }",
	});
	const run = async (actor, account) => {
		Object.assign(globalThis.smallBugs, { actor, account });
		return (await getManagedAccount(new Request("http://x"), account.id)).account;
	};
	const primary = { id: "p", role: "admin", isPrimaryAdmin: true, canManageUsers: true };
	const secondary = { id: "s", role: "admin", isPrimaryAdmin: false, canManageUsers: true };
	const plain = { id: "x", role: "user", isPrimaryAdmin: false, createdByUserId: "other" };
	const otherAdmin = { id: "y", role: "admin", isPrimaryAdmin: false, createdByUserId: "s" };
	assert.ok(await run(primary, plain), "primary admin manages a user it did not create");
	assert.ok(await run(secondary, plain), "secondary admin manages a plain user");
	assert.equal(await run(secondary, otherAdmin), null, "secondary admin cannot act on an admin it created");
	assert.equal(await run({ ...secondary, canManageUsers: false }, plain), null, "needs the manage-users grant");
});
