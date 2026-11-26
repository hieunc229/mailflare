import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Same harness as tests/require-user-migration-required.test.mjs, aimed at the other session seam:
// the ~62 call sites that authenticate through `getCurrentUser` directly (src/lib/auth/cookies.ts)
// instead of `requireUser`. Real route handlers and the real home page run through vinext's
// execution paths against a real SQLite database with the real migrations applied, and then a
// column the session read selects is removed — the shape of a deploy whose database is behind on
// migrations. `getCurrentUser` is covered on both of its auth paths: the Bearer-token branch
// through real route handlers, and the cookie branch through vinext's next/headers shim.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-current-user-migration-"));
after(() => rmSync(directory, { recursive: true, force: true }));

// Test-only stubs: the home page's client graph imports next/link and next/navigation, but none of
// those components render in these tests. The stubs keep browser-only Next internals out of the
// node bundle; `redirect` mirrors the real digest so an unexpected redirect stays loud.
writeFileSync(join(directory, "link-stub.mjs"), "export default function Link() { throw new Error('Link must not render in this test'); }\n");
writeFileSync(
	join(directory, "navigation-stub.mjs"),
	[
		"export function redirect(url) { throw Object.assign(new Error(`NEXT_REDIRECT: ${url}`), { digest: `NEXT_REDIRECT;replace;${url};307` }); }",
		"export function useParams() { throw new Error('useParams must not run in this test'); }",
		"export function usePathname() { throw new Error('usePathname must not run in this test'); }",
		"export function useRouter() { throw new Error('useRouter must not run in this test'); }",
		"export function useSearchParams() { throw new Error('useSearchParams must not run in this test'); }",
	].join("\n") + "\n",
);

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { GET as meGet } from "./src/app/api/auth/me/route.ts";
			export { GET as countsGet } from "./src/app/api/messages/counts/route.ts";
			export { GET as mailboxesGet } from "./src/app/api/mailboxes/route.ts";
			export { getCurrentUser, requireUser } from "./src/lib/auth/cookies.ts";
			export { default as HomePage } from "./src/app/page.tsx";
		`,
		resolveDir: root,
		sourcefile: "current-user-migration-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		// The vinext shim, not the real next package, so the cookie branch runs against vinext's
		// request context. The shim keeps its AsyncLocalStorage on globalThis (Symbol.for), so the
		// bundled copy and the copy this test imports share one store.
		"next/headers": join(root, "node_modules/vinext/dist/shims/headers.js"),
		"next/server": "next/server.js",
		"next/link": join(directory, "link-stub.mjs"),
		"next/navigation": join(directory, "navigation-stub.mjs"),
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const { executeAppRouteHandler } = await import(
	pathToFileURL(join(root, "node_modules/vinext/dist/server/app-route-handler-execution.js")).href
);
const headersShim = await import(pathToFileURL(join(root, "node_modules/vinext/dist/shims/headers.js")).href);

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
function respond(handler, path = "/api/auth/me", method = "GET") {
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

/** `getCurrentUser` on the cookie path, under vinext's real request-context shim. */
function currentUserViaCookie(env = globalThis.__mailflareNodeEnv) {
	const request = new Request("https://mail.test/", { headers: { cookie: `ep_session=${TOKEN}` } });
	return headersShim.runWithHeadersContext(headersShim.headersContextFromRequest(request), () => app.getCurrentUser(env));
}

/**
 * The home page, which reads its session through `getCurrentUser(...).catch(() => null)`. Signed in
 * by default: the page's session read must actually hit the database to exercise it.
 */
function renderHomePage({ signedIn = true } = {}) {
	const request = new Request("https://mail.test/", { headers: signedIn ? { cookie: `ep_session=${TOKEN}` } : {} });
	return headersShim.runWithHeadersContext(headersShim.headersContextFromRequest(request), () => app.HomePage());
}

test("a signed-in request on a database missing a migrated column answers 409, not a 500", async (t) => {
	const store = await database(t);
	store.db.exec("ALTER TABLE users DROP COLUMN totp_last_step");

	const response = await respond(app.meGet);
	const body = await response.text();
	assert.equal(response.status, 409, `expected 409, got ${response.status} ${body}`);
	// The digest channel carries a status only: vinext answers the fallback with an empty body.
	assert.equal(body, "");
	// Fail closed: no session cookie or token comes back with an error answer.
	assert.equal(response.headers.get("set-cookie"), null);
});

test("a second direct getCurrentUser route answers the same way, from the sessions read", async (t) => {
	const store = await database(t);
	store.db.exec("ALTER TABLE sessions DROP COLUMN created_at");

	const response = await respond(app.countsGet, "/api/messages/counts?mailboxId=mb");
	assert.equal(response.status, 409);
	assert.equal(await response.text(), "");
});

test("the cookie path of getCurrentUser throws the 409 fallback for a missing column and returns the user otherwise", async (t) => {
	const store = await database(t);
	const user = await currentUserViaCookie();
	assert.equal(user.id, "u");

	store.db.exec("ALTER TABLE users DROP COLUMN totp_last_step");
	await assert.rejects(currentUserViaCookie(), (error) => {
		assert.equal(error.name, "MigrationRequiredError");
		assert.equal(error.digest, "NEXT_HTTP_ERROR_FALLBACK;409");
		return true;
	});
});

test("requireUser stays a 409 too: its own missing-column catch is now redundant, not wrong", async (t) => {
	const store = await database(t);
	store.db.exec("ALTER TABLE users DROP COLUMN totp_last_step");

	const response = await respond(app.mailboxesGet, "/api/mailboxes");
	assert.equal(response.status, 409);
	assert.equal(await response.text(), "");
});

test("a database that is not there at all stays a 500, so a real outage is never reported as a migration", async (t) => {
	const store = await database(t);
	store.db.close();

	const response = await respond(app.meGet);
	assert.equal(response.status, 500);
});

/** `getCurrentUser` against an env whose database throws `error` on the session read. */
async function getCurrentUserWithError(error) {
	const env = {
		DB: {
			prepare() {
				throw error;
			},
		},
	};
	try {
		return await app.getCurrentUser(env, new Request("https://mail.test/", { headers: { Authorization: `Bearer ${TOKEN}` } }));
	} catch (thrown) {
		return thrown;
	}
	throw new Error("expected getCurrentUser to throw");
}

/** A Drizzle-wrapped driver error, the shape `db.select()` really throws. */
function drizzleError(code, message) {
	return Object.assign(new Error(`Failed query: select ...`), { cause: Object.assign(new Error(message), { code }) });
}

test("getCurrentUser turns a missing column or table into the 409 fallback and nothing else", async () => {
	for (const error of [
		drizzleError("SQLITE_ERROR", 'no such column: "totp_last_step"'),
		drizzleError("42703", 'column "totp_last_step" does not exist'),
		drizzleError("ER_BAD_FIELD_ERROR", "Unknown column 'totp_last_step' in 'field list'"),
	]) {
		const thrown = await getCurrentUserWithError(error);
		assert.equal(thrown.name, "MigrationRequiredError");
		assert.equal(thrown.digest, "NEXT_HTTP_ERROR_FALLBACK;409");
	}
	const missingTable = drizzleError("42P01", 'relation "sessions" does not exist');
	assert.equal((await getCurrentUserWithError(missingTable)).digest, "NEXT_HTTP_ERROR_FALLBACK;409");
});

test("a real outage is rethrown untouched, not relabelled as a pending migration", async () => {
	const outage = drizzleError("ECONNREFUSED", "connection refused");
	assert.equal(await getCurrentUserWithError(outage), outage);
	const locked = drizzleError("SQLITE_BUSY", "database is locked");
	assert.equal(await getCurrentUserWithError(locked), locked);
});

test("the home page lets the pending-migration answer escape instead of rendering signed out", async (t) => {
	const store = await database(t);
	store.db.exec("ALTER TABLE users DROP COLUMN totp_last_step");

	await assert.rejects(renderHomePage(), (error) => {
		assert.equal(error.name, "MigrationRequiredError");
		assert.equal(error.digest, "NEXT_HTTP_ERROR_FALLBACK;409");
		return true;
	});
});

test("the home page still renders for signed-out visitors and real outages, so nothing else moved", async (t) => {
	const store = await database(t);
	// No session: the landing page renders as before.
	const signedOut = await renderHomePage({ signedIn: false });
	assert.ok(signedOut, "expected the landing page element");

	// A dead database is not a migration: the landing page still renders (the session read stays
	// best-effort for everything but a pending migration).
	store.db.close();
	const outage = await renderHomePage();
	assert.ok(outage, "expected the landing page element on a real outage");
});
