import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";
import { loadApp } from "./helpers/real-db.mjs";

// The per-key `canApproveOwnSends` switch on the API keys settings screen, from both ends: the real
// PATCH route that persists it (against a real database) and the screen that flips it, so a refusal
// has to come back as an error instead of a silently flipped switch.

const { app, newDatabase } = await loadApp("mcp-key-own-send-toggle", `
	export { createSession } from "./src/lib/auth/session.ts";
	export * as apiKeysRoute from "./src/app/api/api-keys/route.ts";
	export * as mcpKeysRoute from "./src/app/api/agent/mcp-keys/route.ts";
`);

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 'user', 1);
	INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, can_approve_own_sends, created_at) VALUES
		('key-send', 'mcp', 'owner', 'Agent', 'ep_send', 'h', '["mcp:read","mcp:request-send"]', 0, 1),
		('key-nosend', 'mcp', 'owner', 'Reader', 'ep_read', 'h', '["mcp:read"]', 0, 1);
`;

async function setUp(t) {
	const { env, sqlite } = await newDatabase(t, seed);
	env.MAILFLARE_RUNTIME = "node";
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const token = await app.createSession(env, "owner");
	const request = (path, method = "GET", body) => new Request(`https://mailflare.test${path}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: "https://mailflare.test" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const patch = async (id, canApproveOwnSends) => {
		const response = await app.mcpKeysRoute.PATCH(request("/api/agent/mcp-keys", "PATCH", { id, canApproveOwnSends }));
		return { status: response.status, data: await response.json() };
	};
	const flag = (id) => sqlite.prepare("SELECT can_approve_own_sends FROM api_keys WHERE id = ?").get(id).can_approve_own_sends;
	return { env, sqlite, request, patch, flag };
}

test("the switch reads its state from the same list the screen renders", async (t) => {
	const { request } = await setUp(t);
	const response = await app.apiKeysRoute.GET(request("/api/api-keys"));
	assert.equal(response.status, 200);
	const { apiKeys } = await response.json();
	const send = apiKeys.find((key) => key.id === "key-send");
	assert.equal(send.canApproveOwnSends, false, "off by default");
	assert.ok(apiKeys.every((key) => typeof key.canApproveOwnSends === "boolean"), "every listed key carries the flag");
});

test("turning the switch on persists through PATCH /api/agent/mcp-keys", async (t) => {
	const { patch, flag } = await setUp(t);
	const result = await patch("key-send", true);
	assert.equal(result.status, 200, JSON.stringify(result.data));
	assert.deepEqual(result.data, { id: "key-send", canApproveOwnSends: true });
	assert.equal(flag("key-send"), 1);
	const off = await patch("key-send", false);
	assert.equal(off.status, 200);
	assert.equal(flag("key-send"), 0);
});

test("a key without mcp:request-send is refused and stays off", async (t) => {
	const { patch, flag } = await setUp(t);
	const result = await patch("key-nosend", true);
	assert.equal(result.status, 400);
	assert.match(result.data.error, /mcp:request-send/);
	assert.equal(flag("key-nosend"), 0, "a refusal must not leave the flag set");
});

// --- the screen itself -------------------------------------------------------
// jsdom, the real component, the real Switch and Checkbox; only the network and the providers the
// settings page already supplies are stubbed.

const language = `const t = (key) => key; export function useLanguage() { return { t }; }`;
const mailbox = `export function useSelectedMailbox() { return { mailboxes: [], selectedMailbox: null }; }`;
const authClient = `
export async function authFetch(url, init = {}) {
	globalThis.__requests.push({ url, method: init.method ?? "GET", body: init.body });
	if (url === "/api/api-keys") return { ok: true, async json() { return { apiKeys: globalThis.__keys }; } };
	if (url === "/api/agent/mcp-keys") return new Promise((resolve) => { globalThis.__answer = resolve; });
	return { ok: false, async json() { return { error: "unexpected " + url }; } };
}`;

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

test("the screen shows the switch only for keys that may request a send, and reverts a refusal", async (t) => {
	globalThis.__requests = [];
	globalThis.__keys = [
		{ id: "key-send", name: "Agent", prefix: "ep_send", kind: "mcp", scopes: '["mcp:read","mcp:request-send"]', mailboxIds: [], mailboxScopeEnabled: false, canApproveOwnSends: false, createdAt: "2025-01-01T00:00:00Z", lastUsedAt: null },
		{ id: "key-nosend", name: "Reader", prefix: "ep_read", kind: "mcp", scopes: '["mcp:read"]', mailboxIds: [], mailboxScopeEnabled: false, canApproveOwnSends: false, createdAt: "2025-01-01T00:00:00Z", lastUsedAt: null },
		{ id: "key-legacy", name: "Old", prefix: "ep_old", kind: "legacy", scopes: '["read"]', mailboxIds: [], mailboxScopeEnabled: true, canApproveOwnSends: false, createdAt: "2025-01-01T00:00:00Z", lastUsedAt: null },
	];
	const { ApiKeysSettings } = await loadComponent("src/components/settings/api-keys-settings.tsx", {
		"@/components/language-provider": language,
		"@/components/mailbox-provider": mailbox,
		"@/lib/auth/client": authClient,
		"@/components/ui/confirm-dialog": `export async function confirmDestructive() { return false; }`,
		"./security-status-store": `export function useSecurityStatus() { return { status: null }; }`,
		"./step-up-dialog": `export function StepUpDialog() { return null; }`,
		"@/components/settings/mcp-agent-instructions": `export function McpAgentInstructions() { return null; }`,
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(createElement(ApiKeysSettings)); });

	const switches = container.querySelectorAll('[role="switch"]');
	assert.equal(switches.length, 1, "only the key holding mcp:request-send gets the switch");
	const toggle = switches[0];
	assert.equal(toggle.getAttribute("aria-checked"), "false", "the flag is off by default");
	// The wording is the label wrapping the switch, so the control has an accessible name and the
	// consequence line sits next to it.
	const label = toggle.closest("label");
	assert.ok(label, "the switch sits inside its label");
	assert.match(label.textContent, /apiKeys\.ownSendApproval\.label/);
	assert.match(label.textContent, /apiKeys\.ownSendApproval\.description/);

	await act(async () => { toggle.click(); });
	const patch = globalThis.__requests.find((call) => call.url === "/api/agent/mcp-keys");
	assert.deepEqual(patch, { url: "/api/agent/mcp-keys", method: "PATCH", body: JSON.stringify({ id: "key-send", canApproveOwnSends: true }) });
	assert.equal(toggle.getAttribute("aria-checked"), "true", "the switch flips while the save is in flight");

	await act(async () => { globalThis.__answer({ ok: false, async json() { return { error: "Give this key the mcp:request-send tool first" }; } }); });
	assert.equal(toggle.getAttribute("aria-checked"), "false", "a refusal puts the switch back");
	assert.match(container.querySelector('[role="alert"]').textContent, /mcp:request-send/);
});
