import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(project, "node_modules", "permission-user-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({ entryPoints: [join(project, "src/hooks/use-current-user.ts")], outfile: join(directory, "user.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", plugins: [{ name: "test-auth", setup(builder) { builder.onResolve({ filter: /^@\/lib\/auth\/client$/ }, () => ({ path: "auth", namespace: "mock" })); builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export const AUTH_SESSION_CHANGED_EVENT='permission-session-changed';export function authFetch(){return globalThis.fetchUserResponse()}", loader: "js" })); } }], logLevel: "silent" });
const { fetchCurrentUser, clearCurrentUserCache, useCurrentUser } = await import(pathToFileURL(join(directory, "user.mjs")).href);
globalThis.fetch = () => globalThis.fetchUserResponse();
const response = role => ({ ok: true, json: async () => ({ user: { id: role, role, isPrimaryAdmin: role === "admin", canManageDomains: role === "admin" } }) });

test("an old account response cannot repopulate permissions or clear the new inflight request", async () => {
	clearCurrentUserCache(); let oldResolve, newResolve;
	globalThis.fetchUserResponse = () => new Promise(resolve => { oldResolve = resolve; });
	const oldRequest = fetchCurrentUser();
	clearCurrentUserCache();
	globalThis.fetchUserResponse = () => new Promise(resolve => { newResolve = resolve; });
	const newRequest = fetchCurrentUser();
	oldResolve(response("admin")); assert.equal(await oldRequest, null);
	assert.equal(fetchCurrentUser(), newRequest);
	newResolve(response("user")); assert.equal((await newRequest).role, "user");
	assert.equal((await fetchCurrentUser()).canManageDomains, false);
});
test("account switch immediately hides old permission UI until the new account resolves", async () => {
	const dom = new JSDOM("<!doctype html><div id='root'></div>");
	globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	const { createElement, act } = await import("react"); const { createRoot } = await import("react-dom/client");
	clearCurrentUserCache(); globalThis.fetchUserResponse = async () => response("admin"); await fetchCurrentUser();
	function Fixture() { const user = useCurrentUser(); return createElement("div", null, user?.canManageDomains ? "domain admin" : "no domain permission"); }
	const root = createRoot(document.getElementById("root")); await act(async () => root.render(createElement(Fixture)));
	assert.equal(document.body.textContent, "domain admin"); let resolve;
	globalThis.fetchUserResponse = () => new Promise(done => { resolve = done; });
	await act(async () => window.dispatchEvent(new dom.window.Event("permission-session-changed")));
	assert.equal(document.body.textContent, "no domain permission");
	await act(async () => resolve(response("user"))); assert.equal(document.body.textContent, "no domain permission");
	await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document; delete globalThis.IS_REACT_ACT_ENVIRONMENT; delete globalThis.fetchUserResponse;
});
