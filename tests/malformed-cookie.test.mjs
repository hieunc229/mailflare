import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(root, "tests", ".tmp-malformed-cookie-"));
after(() => rmSync(temporary, { recursive: true, force: true }));

const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.malformedCookieEnv ?? {}}",
	"next/headers": "export async function cookies(){return {get: () => undefined}}",
	"next/server": "export const NextResponse = { json: (body, init) => Response.json(body, init) }",
	"@/lib/auth/origin": "export function isSameOriginRequest(){return true}",
	"@/lib/auth/accounts": [
		'export const ACCOUNTS_COOKIE = "ep_accounts";',
		"export function parseAccountTokens(){return []}",
		'export function serializeAccountTokens(){return ""}',
		"export function cookieOptions(){return {}}",
		"export async function resolveAccounts(env, tokens){globalThis.malformedCookieTokens = tokens; return []}",
	].join("\n"),
};

await build({
	entryPoints: {
		session: join(root, "src/lib/auth/session.ts"),
		realtime: join(root, "src/lib/realtime/utils.ts"),
		accounts: join(root, "src/app/api/auth/accounts/route.ts"),
	},
	outdir: temporary,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	alias: { "@": join(root, "src") },
	packages: "external",
	logLevel: "silent",
	plugins: [{
		name: "malformed-cookie-fixtures",
		setup(builder) {
			builder.onResolve(
				{ filter: /^@\/lib\/(cloudflare|auth\/accounts|auth\/origin)$|^next\/(headers|server)$/ },
				(args) => ({ path: args.path, namespace: "mock" }),
			);
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
});

const { getSessionTokenFromRequestHeaders, SESSION_COOKIE } = await import(pathToFileURL(join(temporary, "session.mjs")).href);
const { getSessionTokenFromRequest } = await import(pathToFileURL(join(temporary, "realtime.mjs")).href);
const { GET: getAccounts } = await import(pathToFileURL(join(temporary, "accounts.mjs")).href);

const withCookie = (cookie, headers = {}) => new Request("https://mail.test/api/auth/accounts", { headers: { cookie, ...headers } });

test("a bare or truncated escape in the session cookie reads as no session, not a throw", () => {
	for (const cookie of [`${SESSION_COOKIE}=%`, `${SESSION_COOKIE}=%2`, `${SESSION_COOKIE}=%zz`, `keep=1; ${SESSION_COOKIE}=%; other=2`]) {
		assert.equal(getSessionTokenFromRequestHeaders(withCookie(cookie)), undefined, cookie);
		assert.equal(getSessionTokenFromRequest(withCookie(cookie)), undefined, cookie);
	}
});

test("valid percent-encoding still decodes and plain values pass through", () => {
	for (const extract of [getSessionTokenFromRequestHeaders, getSessionTokenFromRequest]) {
		assert.equal(extract(withCookie(`${SESSION_COOKIE}=abc%20def`)), "abc def");
		assert.equal(extract(withCookie(`${SESSION_COOKIE}=%25`)), "%");
		assert.equal(extract(withCookie(`${SESSION_COOKIE}=ok`)), "ok");
		assert.equal(extract(withCookie(`${SESSION_COOKIE}=a%3Db`)), "a=b");
	}
});

test("a missing cookie and malformed values in other cookies are unaffected", () => {
	for (const extract of [getSessionTokenFromRequestHeaders, getSessionTokenFromRequest]) {
		assert.equal(extract(new Request("https://mail.test/api/auth/accounts")), undefined);
		assert.equal(extract(withCookie("other=%")), undefined);
		assert.equal(extract(withCookie(`other=%; ${SESSION_COOKIE}=good`)), "good");
		assert.equal(extract(withCookie(`${SESSION_COOKIE}=good; other=%`)), "good");
	}
});

test("a Bearer token still takes precedence over any cookie", () => {
	assert.equal(getSessionTokenFromRequestHeaders(withCookie(`${SESSION_COOKIE}=%`, { authorization: "Bearer sess_abc" })), "sess_abc");
});

test("GET /api/auth/accounts answers a malformed session cookie instead of throwing", async () => {
	const response = await getAccounts(withCookie(`${SESSION_COOKIE}=%`));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { accounts: [] });
	// The malformed value behaved as "no session": no token reached the resolver.
	assert.deepEqual(globalThis.malformedCookieTokens, []);
});

test("GET /api/auth/accounts still decodes a valid encoded token", async () => {
	const response = await getAccounts(withCookie(`${SESSION_COOKIE}=abc%20def`));
	assert.equal(response.status, 200);
	assert.deepEqual(globalThis.malformedCookieTokens, ["abc def"]);
});
