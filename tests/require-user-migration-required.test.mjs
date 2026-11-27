import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Runs a real route handler (`/api/mailboxes` GET, one of the ~72 `requireUser` sites) through
// vinext's real route-handler execution path against a real SQLite database with the real
// migrations applied, and then removes a column the session read selects. That is the shape of a
// deploy whose database is behind on migrations, and the response is what the browser sees.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-auth-migration-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { GET as mailboxesGet } from "./src/app/api/mailboxes/route.ts";
			export { GET as foldersGet } from "./src/app/api/folders/route.ts";
			export { PUT as brandingPut } from "./src/app/api/branding/route.ts";
			export { POST as restorePost } from "./src/app/api/backups/restore/route.ts";
			export { authorizeAdminRequest } from "./src/app/api/admin/update/utils.ts";
			export { requireLicenseAdmin } from "./src/app/api/licenses/utils.ts";
			export { requireTeamAdmin } from "./src/app/api/accounts/utils.ts";
			export { requireUser, getCurrentUser } from "./src/lib/auth/cookies.ts";
		`,
		resolveDir: root,
		sourcefile: "auth-migration-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const { executeAppRouteHandler } = await import(
	pathToFileURL(join(root, "node_modules/vinext/dist/server/app-route-handler-execution.js")).href
);

const TOKEN = "sess-token-for-test";

async function database(t) {
	const store = new app.SqliteDatabase(":memory:");
	t.after(() => store.db.close());
	await app.applyMigrations(store, join(root, "drizzle", "migrations"));
	const tokenHash = createHash("sha256").update(TOKEN).digest("hex");
	store.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u', 'o@one.test', 'hash', 'O', 'admin', 1);
		INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('s', 'u', '${tokenHash}', ${Math.floor(Date.now() / 1000) + 86_400}, 1);
	`);
	globalThis.__mailflareNodeEnv = { DB: store, MAILFLARE_RUNTIME: "node" };
	return store;
}

/** The response vinext answers with for a route handler, exactly as the Worker maps it. */
function respond(handler, path = "/api/mailboxes", method = "GET") {
	const url = `https://mail.test${path}`;
	const request = new Request(url, { method, headers: { Authorization: `Bearer ${TOKEN}`, Origin: "https://mail.test" } });
	return executeAppRouteHandler({
		request,
		routePattern: new URL(url).pathname,
		params: {},
		handler: { [method]: handler, runtime: "edge", dynamic: "force-dynamic" },
		handlerFn: (req) => handler(req, { params: {} }),
		method,
		isAutoHead: false,
		isProduction: false,
		revalidateSeconds: null,
		consumeDynamicUsage: () => false,
		markDynamicUsage: () => {},
		setHeadersAccessPhase: () => "route-handler",
		getAndClearPendingCookies: () => [],
		getActiveDraftModeState: () => false,
		getDraftModeCookieHeader: () => null,
		initialDraftModeCookie: null,
		clearRequestContext: () => {},
		reportRequestError: async () => {},
		middlewareContext: {},
	});
}

test("a signed-in request on a database missing a migrated column answers MIGRATION_REQUIRED, not a 500", async (t) => {
	const store = await database(t);
	store.db.exec("ALTER TABLE users DROP COLUMN totp_last_step");

	const response = await respond(app.mailboxesGet);
	const body = await response.text();
	assert.equal(response.status, 409, `expected 409, got ${response.status} ${body}`);
	// The digest channel carries a status only: vinext answers the fallback with an empty body.
	assert.equal(body, "");
	// Fail closed: no session cookie or token comes back with an error answer.
	assert.equal(response.headers.get("set-cookie"), null);
});

test("a second requireUser route answers the same way, from the sessions read", async (t) => {
	const store = await database(t);
	store.db.exec("ALTER TABLE sessions DROP COLUMN created_at");

	const response = await respond(app.foldersGet, "/api/folders?mailboxId=mb");
	assert.equal(response.status, 409);
	assert.equal(await response.text(), "");
});

test("a database that is not there at all stays a 500, so a real outage is never reported as a migration", async (t) => {
	const store = await database(t);
	store.db.close();

	const response = await respond(app.mailboxesGet);
	assert.equal(response.status, 500);
});

/** `requireUser` against an env whose database throws `error` on the session read. */
async function requireUserWithError(error, request) {
	const env = {
		DB: {
			prepare() {
				throw error;
			},
		},
	};
	try {
		await app.requireUser(env, request);
	} catch (thrown) {
		return thrown;
	}
	throw new Error("expected requireUser to throw");
}

function authorized(path = "/api/mailboxes") {
	return new Request(`https://mail.test${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
}

/** A Drizzle-wrapped driver error, the shape `db.select()` really throws. */
function drizzleError(code, message) {
	return Object.assign(new Error(`Failed query: select ...`), { cause: Object.assign(new Error(message), { code }) });
}

test("requireUser turns a missing column into the 409 fallback and nothing else", async (t) => {
	await database(t);
	for (const error of [
		drizzleError("SQLITE_ERROR", 'no such column: "totp_last_step"'),
		drizzleError("42703", 'column "totp_last_step" does not exist'),
		drizzleError("ER_BAD_FIELD_ERROR", "Unknown column 'totp_last_step' in 'field list'"),
	]) {
		const thrown = await requireUserWithError(error, authorized());
		assert.equal(thrown.name, "MigrationRequiredError");
		assert.equal(thrown.digest, "NEXT_HTTP_ERROR_FALLBACK;409");
	}
	const missingTable = drizzleError("42P01", 'relation "sessions" does not exist');
	assert.equal((await requireUserWithError(missingTable, authorized())).digest, "NEXT_HTTP_ERROR_FALLBACK;409");
});

test("a real outage is rethrown untouched, not relabelled as a pending migration", async (t) => {
	await database(t);
	const outage = drizzleError("ECONNREFUSED", "connection refused");
	assert.equal(await requireUserWithError(outage, authorized()), outage);
	const locked = drizzleError("SQLITE_BUSY", "database is locked");
	assert.equal(await requireUserWithError(locked, authorized()), locked);
});

// The five helpers below call `requireUser` inside a catch-all that turns any failure into an admin
// answer (401 / 403 / 400). A pending migration must not be reported as "signed out" or
// "forbidden", so each one rethrows it and lets the 409 fallback answer.
const SWALLOWING_HELPERS = {
	"admin/update/utils authorizeAdminRequest": (request) => app.authorizeAdminRequest(request),
	"licenses/utils requireLicenseAdmin": (request) => app.requireLicenseAdmin(globalThis.__mailflareNodeEnv, request),
	"accounts/utils requireTeamAdmin": (request) => app.requireTeamAdmin(request),
};

for (const [name, call] of Object.entries(SWALLOWING_HELPERS)) {
	test(`${name} rethrows the pending-migration answer instead of 401/403`, async (t) => {
		const store = await database(t);
		store.db.exec("ALTER TABLE users DROP COLUMN totp_last_step");
		let thrown;
		try {
			await call(authorized());
		} catch (error) {
			thrown = error;
		}
		assert.equal(thrown?.name, "MigrationRequiredError", `expected a MigrationRequiredError, got ${thrown}`);
		assert.equal(thrown.digest, "NEXT_HTTP_ERROR_FALLBACK;409");
	});
}

test("those helpers still answer 401/403 for their real failures, so nothing else moved", async (t) => {
	const store = await database(t);
	store.db.close();
	// Not a migration: the helper's own answer is unchanged.
	const outage = await app.authorizeAdminRequest(authorized());
	assert.equal(outage.error.status, 401);
	assert.equal((await app.requireTeamAdmin(authorized())).error.status, 403);
	assert.equal((await app.requireLicenseAdmin(globalThis.__mailflareNodeEnv, authorized())).status, 403);
});

test("the branding and restore routes answer 409 for a pending migration, not their own 403/400", async (t) => {
	const store = await database(t);
	store.db.exec("ALTER TABLE users DROP COLUMN totp_last_step");
	assert.equal((await respond(app.brandingPut, "/api/branding", "PUT")).status, 409);
	assert.equal((await respond(app.restorePost, "/api/backups/restore", "POST")).status, 409);
});
