import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(project, "node_modules", "landing-account-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const mocks = {
	"@/lib/auth/client": `
		export const AUTH_SESSION_CHANGED_EVENT = "test-auth-changed";
		export function getClientSessionToken() { return globalThis.__landingToken ?? null; }
	`,
	"@/hooks/use-current-user": `
		export function clearCurrentUserCache() { globalThis.__landingClears = (globalThis.__landingClears ?? 0) + 1; }
		export function fetchCurrentUser() {
			globalThis.__landingFetches = (globalThis.__landingFetches ?? 0) + 1;
			return Promise.resolve(globalThis.__landingNextUser ?? null);
		}
	`,
};

await build({
	entryPoints: [join(project, "src/app/home-auth.tsx")],
	outfile: join(directory, "home-auth.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	jsx: "automatic",
	logLevel: "silent",
	plugins: [{
		name: "landing-account-mocks",
		setup(builder) {
			builder.onResolve({ filter: /^@\// }, ({ path }) => path in mocks ? { path, namespace: "mock" } : undefined);
			builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: mocks[path], loader: "js" }));
		},
	}],
});

const { HomeAuthProvider, useHomeAuth } = await import(pathToFileURL(join(directory, "home-auth.mjs")).href);
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const account = {
	id: "usr_landing",
	email: "landing@example.com",
	name: "Landing User",
	role: "admin",
	hasAvatar: false,
};

const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
	dom.window.close();
	delete globalThis.window;
	delete globalThis.document;
	delete globalThis.IS_REACT_ACT_ENVIRONMENT;
	delete globalThis.__landingToken;
	delete globalThis.__landingNextUser;
	delete globalThis.__landingFetches;
	delete globalThis.__landingClears;
});

function Probe() {
	const user = useHomeAuth();
	return createElement("div", { id: "who" }, user?.email ?? "anonymous");
}

async function render(initialUser) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(createElement(HomeAuthProvider, { initialUser }, createElement(Probe))));
	return {
		text: () => container.textContent,
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

test("a server-resolved account renders without an /api/auth/me request", async () => {
	globalThis.__landingToken = null;
	globalThis.__landingFetches = 0;
	const view = await render(account);
	assert.equal(view.text(), "landing@example.com");
	assert.equal(globalThis.__landingFetches, 0);
	await view.unmount();
});

test("a confirmed anonymous visitor does not ask the server again", async () => {
	globalThis.__landingToken = null;
	globalThis.__landingFetches = 0;
	const view = await render(null);
	assert.equal(view.text(), "anonymous");
	assert.equal(globalThis.__landingFetches, 0);
	await view.unmount();
});

test("a bearer token the server cannot see still verifies the account", async () => {
	globalThis.__landingToken = "sess_bearer";
	globalThis.__landingFetches = 0;
	globalThis.__landingNextUser = { ...account, email: "bearer@example.com" };
	const view = await render(null);
	assert.equal(view.text(), "bearer@example.com");
	assert.equal(globalThis.__landingFetches, 1);
	await view.unmount();
});

test("without a server answer the provider checks the session itself", async () => {
	globalThis.__landingToken = null;
	globalThis.__landingFetches = 0;
	globalThis.__landingNextUser = account;
	const view = await render(undefined);
	assert.equal(view.text(), "landing@example.com");
	assert.equal(globalThis.__landingFetches, 1);
	await view.unmount();
});

test("a session change clears the cache and replaces the account", async () => {
	globalThis.__landingToken = null;
	globalThis.__landingFetches = 0;
	globalThis.__landingClears = 0;
	globalThis.__landingNextUser = { ...account, email: "next@example.com" };
	const view = await render(account);
	assert.equal(view.text(), "landing@example.com");

	globalThis.__landingToken = "sess_next";
	await act(async () => {
		dom.window.dispatchEvent(new dom.window.Event("test-auth-changed"));
	});

	assert.equal(globalThis.__landingClears, 1);
	assert.equal(globalThis.__landingFetches, 1);
	assert.equal(view.text(), "next@example.com");
	await view.unmount();
});
