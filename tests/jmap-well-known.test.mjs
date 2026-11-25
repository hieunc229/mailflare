import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

// /.well-known/jmap answers every method a client may send to the URL it was given, always as JSON.
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.jmapEnv}",
	"@/lib/api/key-auth": `
		export async function authenticateApiRequest(env, request){ return request.headers.get("Authorization") === "Bearer good" ? { userId: "u1", email: "u1@example.com", user: { id: "u1", email: "u1@example.com", role: "user" }, scopes: ["jmap"], mailboxIds: null, keyId: "k" } : null }
		export function hasScope(scopes, scope){ return scopes.includes(scope) }
		export async function authenticateApiKeyValue(){ return null }`,
};
const { app, newDatabase } = await loadApp("jmap-well-known", `
	export * as wellKnown from "./src/app/.well-known/jmap/route.ts";
	export { jmapSessionUrl } from "./src/lib/jmap/session.ts";
`, { mocks });

const URL_ = "https://mail.example.com/.well-known/jmap";
const echo = JSON.stringify({ using: ["urn:ietf:params:jmap:core"], methodCalls: [["Core/echo", { hello: true }, "c0"]] });
async function setup(t, vars = {}) {
	const { env } = await newDatabase(t);
	globalThis.jmapEnv = { ...env, ...vars };
}

test("OPTIONS answers the CORS preflight instead of a framework 405", async (t) => {
	await setup(t);
	const response = await app.wellKnown.OPTIONS(new Request(URL_, { method: "OPTIONS" }));
	assert.equal(response.status, 204);
	assert.match(response.headers.get("Access-Control-Allow-Methods"), /POST/);
});

test("GET without credentials redirects to the session, with them serves the session in place", async (t) => {
	await setup(t);
	const redirect = await app.wellKnown.GET(new Request(URL_));
	assert.equal(redirect.status, 301);
	assert.equal(redirect.headers.get("Location"), "https://mail.example.com/jmap/session");
	const session = await app.wellKnown.GET(new Request(URL_, { headers: { Authorization: "Bearer good" } }));
	assert.equal(session.status, 200);
	assert.equal((await session.json()).apiUrl, "https://mail.example.com/jmap/api");
});

test("POST with credentials is served as an API request, not a 405", async (t) => {
	await setup(t);
	const response = await app.wellKnown.POST(new Request(URL_, { method: "POST", body: echo, headers: { Authorization: "Bearer good", "Content-Type": "application/json" } }));
	assert.equal(response.status, 200);
	assert.deepEqual((await response.json()).methodResponses, [["Core/echo", { hello: true }, "c0"]]);
});

test("POST without credentials is a JSON 401, never HTML", async (t) => {
	await setup(t);
	const response = await app.wellKnown.POST(new Request(URL_, { method: "POST", body: echo }));
	assert.equal(response.status, 401);
	assert.match(response.headers.get("Content-Type"), /json/);
	assert.match(response.headers.get("WWW-Authenticate"), /Basic/);
});

test("the advertised session URL prefers APP_URL over the request origin", () => {
	assert.equal(app.jmapSessionUrl({ APP_URL: " https://mail.example.org " }, new Request(URL_)), "https://mail.example.org/jmap/session");
	assert.equal(app.jmapSessionUrl({}, new Request(URL_)), "https://mail.example.com/jmap/session");
});
