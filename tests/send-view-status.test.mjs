import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-send-view-status-"));
const outfile = join(outDir, "hook.mjs");
after(() => rmSync(outDir, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event"]) {
	globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = new Map([
	["next/navigation", `
		const router = {
			replace(destination) { globalThis.__sendViewReplace(destination); },
			push() {},
			refresh() {},
			back() {},
			forward() {},
			prefetch() {},
		};
		export function usePathname() { return globalThis.__sendViewPathname; }
		export function useRouter() { return router; }
	`],
	["@/lib/auth/client", `
		export function authFetch(...args) { return globalThis.__sendViewFetch(...args); }
	`],
	["@/lib/messages/detail-cache", `
		export function clearMessageDetailCache() { globalThis.__sendViewClearCache(); }
	`],
]);

await build({
	stdin: {
		contents: `
			import { createElement } from "react";
			import { createRoot } from "react-dom/client";
			import { act } from "react";
			import { useSendViewStatus } from "@/components/messages/use-send-view-status";

			async function flushTurns() {
				for (let turn = 0; turn < 3; turn++) {
					await new Promise(resolve => setImmediate(resolve));
				}
			}
			async function settle() {
				await act(async () => { await flushTurns(); });
			}

			export async function mountReader(messageId) {
				document.body.replaceChildren();
				const container = document.createElement("div");
				document.body.appendChild(container);
				const root = createRoot(container);
				function Reader() {
					useSendViewStatus(messageId);
					return null;
				}
				await act(async () => { root.render(createElement(Reader)); });
				await settle();
				return {
					async unmount() { await act(async () => { root.unmount(); }); },
				};
			}

			export async function messagesChanged() {
				await act(async () => {
					window.dispatchEvent(new window.Event("mailflare:messages-changed"));
				});
				await settle();
			}
		`,
		resolveDir: root,
		loader: "tsx",
	},
	outfile,
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "es2022",
	tsconfig: join(root, "tsconfig.json"),
	external: ["react", "react-dom", "react-dom/client", "jsdom"],
	alias: { "@": join(root, "src") },
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
	plugins: [{
		name: "send-view-status-mocks",
		setup(builder) {
			builder.onResolve({ filter: /.*/ }, args => {
				if (mocks.has(args.path)) return { path: args.path, namespace: "send-view-status-mock" };
				return undefined;
			});
			builder.onLoad({ filter: /.*/, namespace: "send-view-status-mock" }, args => ({ contents: mocks.get(args.path), loader: "js" }));
		},
	}],
	logLevel: "silent",
});

const { mountReader, messagesChanged } = await import(pathToFileURL(outfile).href);

function statusResponse(status, ok = true) {
	return { ok, status: ok ? 200 : 500, json: async () => ({ status }) };
}

/** Installs mutable pathname, stable-router replace spy, controlled fetch and cache-clear spy. */
function prepare({ pathname, responses = [] }) {
	const calls = [];
	const replacements = [];
	const cleared = [];
	const queue = [...responses];
	globalThis.__sendViewPathname = pathname;
	globalThis.__sendViewReplace = destination => { replacements.push(destination); };
	globalThis.__sendViewFetch = async (url, init) => {
		calls.push({ url: String(url), cache: init?.cache });
		if (queue.length === 0) throw new Error(`unexpected status request for ${url}`);
		const next = queue.shift();
		return typeof next === "function" ? next() : next;
	};
	globalThis.__sendViewClearCache = () => { cleared.push(true); };
	return { calls, replacements, cleared, queue };
}

function trackMessagesChanged(t) {
	const seen = [];
	const listener = () => { seen.push("changed"); };
	window.addEventListener("mailflare:messages-changed", listener);
	t.after(() => window.removeEventListener("mailflare:messages-changed", listener));
	return seen;
}

test("a scheduled reader navigates to the sent reader after confirmed delivery and clears its cache", async t => {
	const view = prepare({ pathname: "/scheduled/msg-1", responses: [statusResponse("sent")] });
	const changes = trackMessagesChanged(t);
	const reader = await mountReader("msg-1");
	t.after(() => reader.unmount());

	assert.deepEqual(view.calls, [{ url: "/api/messages/msg-1/send-status", cache: "no-store" }]);
	assert.deepEqual(view.replacements, ["/sent/msg-1"]);
	assert.equal(view.cleared.length, 1, "the reader's detail cache is cleared before the move");
	assert.deepEqual(changes, ["changed"], "listeners learn the message list needs to refresh");
	assert.equal(view.calls.length, 1, "the emitted change event does not fetch again after moving");
});

test("a messages-changed event re-checks a scheduled reader until delivery is confirmed", async t => {
	const view = prepare({
		pathname: "/scheduled/msg-2",
		responses: [statusResponse("queued"), statusResponse("sent")],
	});
	const reader = await mountReader("msg-2");
	t.after(() => reader.unmount());

	assert.equal(view.calls.length, 1);
	assert.deepEqual(view.replacements, [], "a queued message stays in the scheduled reader");

	await messagesChanged();

	assert.equal(view.calls.length, 2);
	assert.deepEqual(view.replacements, ["/sent/msg-2"]);
	assert.equal(view.cleared.length, 1);
});

for (const [pathname, destination] of [
	["/scheduled/msg-draft", "/scheduled"],
	["/sent/msg-draft", "/sent"],
]) {
	test(`a draft status closes the ${pathname.startsWith("/scheduled/") ? "scheduled" : "sent"} reader`, async t => {
		const view = prepare({ pathname, responses: [statusResponse("draft")] });
		const changes = trackMessagesChanged(t);
		const reader = await mountReader("msg-draft");
		t.after(() => reader.unmount());

		assert.deepEqual(view.replacements, [destination]);
		assert.equal(view.cleared.length, 1);
		assert.deepEqual(changes, ["changed"]);
	});
}

test("folder lists and unrelated message routes never request status or navigate", async () => {
	for (const pathname of ["/scheduled", "/sent", "/inbox", "/scheduled/other-id", "/sent/other-id", "/inbox/msg-3"]) {
		const view = prepare({ pathname, responses: [] });
		const reader = await mountReader("msg-3");
		await reader.unmount();

		assert.equal(view.calls.length, 0, `${pathname} does not poll`);
		assert.deepEqual(view.replacements, [], `${pathname} does not navigate`);
		assert.equal(view.cleared.length, 0, `${pathname} does not clear a cache`);
	}
});

test("a status response resolved after unmount cannot navigate or clear the cache", async t => {
	let resolveFetch;
	const view = prepare({
		pathname: "/scheduled/msg-inflight",
		responses: [() => new Promise(resolve => { resolveFetch = resolve; })],
	});
	const changes = trackMessagesChanged(t);
	const reader = await mountReader("msg-inflight");
	assert.equal(view.calls.length, 1);

	await reader.unmount();
	resolveFetch(statusResponse("sent"));
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));

	assert.deepEqual(view.replacements, []);
	assert.equal(view.cleared.length, 0);
	assert.deepEqual(changes, []);
});
