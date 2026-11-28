import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const pass = `import React from "react"; export const Button = ({children, variant, size, asChild, ...p}) => React.createElement("button", p, children); export const Badge = ({children}) => React.createElement("span", null, children);`;
const mod = await loadComponent("src/components/settings/api-keys-settings.tsx", {
	"@/components/page-header-utils": 'export const mobilePrimaryActionAboveNavClass = "";',
	"@/components/ui/confirm-dialog": "export async function confirmDestructive() { return true; }",
	"@/components/icons": "const I = () => null; export const Copy = I, KeyRound = I, Plus = I, Trash2 = I;",
	"@/components/language-provider": "const t = (key) => key; export function useLanguage() { return { t }; }",
	"@/components/mailbox-provider": "export function useSelectedMailbox() { return { mailboxes: [], selectedMailbox: null }; }",
	"@/components/ui/badge": pass,
	"@/components/ui/button": pass,
	"@/components/ui/checkbox": `import React from "react"; export const Checkbox = (p) => React.createElement("input", { type: "checkbox", ...p });`,
	"@/components/ui/dialog": `import React from "react"; const W = ({children}) => React.createElement("div", null, children); export const Dialog = W, DialogContent = W, DialogDescription = W, DialogHeader = W, DialogTitle = W, DialogTrigger = W;`,
	"@/components/ui/input": `import React from "react"; export const Input = (p) => React.createElement("input", p);`,
	"@/components/ui/label": `import React from "react"; export const Label = ({children}) => React.createElement("label", null, children);`,
	"@/components/ui/list": `import React from "react"; const W = ({children}) => React.createElement("div", null, children); export const List = W, ListRow = W;`,
	"@/components/page-skeletons": "export const SectionRowSkeleton = () => null;",
	"@/lib/time/utils": "export const formatUserDate = (d) => String(d);",
	"@/components/settings/mcp-agent-instructions": "export const McpAgentInstructions = () => null;",
	"@/lib/http/client-error": "export class ClientRequestError extends Error {}",
	"./security-status-store": "export function useSecurityStatus() { return { status: null }; }",
	"./step-up-dialog": "export const StepUpDialog = () => null;",
	"./api-keys-settings-utils": `
export const MCP_KEY_SCOPES = [], STANDARD_KEY_SCOPES = [];
export const keyPermissions = () => [];
export async function loadManagedApiKeys() { return []; }
export async function createManagedApiKey() { throw new Error("raw create failure"); }
export async function revokeManagedApiKey() {}`,
});

test("with no keys, a failed create is not shown as a failed list load", async (t) => {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(createElement(mod.ApiKeysSettings)); });
	await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	assert.ok(container.textContent.includes("apiKeys.none"));
	const name = container.querySelector("#managed-key-name");
	const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
	await act(async () => { setValue.call(name, "k"); name.dispatchEvent(new Event("input", { bubbles: true })); });
	await act(async () => { container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 0)); });
	assert.ok(container.textContent.includes("raw create failure"), "the create error is shown");
	assert.ok(!container.textContent.includes("list.loadFailed"), "not as a load failure");
	assert.ok(container.textContent.includes("apiKeys.none"), "the empty text stays");
});
