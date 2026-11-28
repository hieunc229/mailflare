import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, beforeEach } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Removing a mailbox from an account must ask first, naming the address.

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-account-mailbox-remove-"));
after(() => rmSync(temp, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event"]) {
  globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mock = new Map([
  ["next/navigation", `export function useParams() { return { id: "acct-1" }; }`],
  ["next/link", `import React from "react"; export default function Link({ children, href, ...p }) { return React.createElement("a", { href, ...p }, children); }`],
  // t must be referentially stable: the page's load effect depends on it.
  ["@/components/language-provider", `
const value = { t(key, vars) { return vars?.address ? key + ":" + vars.address : key; } };
export function useLanguage() { return value; }
`],
  ["@/components/icons", `import React from "react"; export const Plus = () => null; export const Trash2 = () => React.createElement("i");`],
  ["@/components/ui/confirm-dialog", `export function confirmDestructive(message) { globalThis.__confirmed.push(message); return Promise.resolve(globalThis.__confirmAnswer); }`],
  ["@/components/ui/button", `
import React from "react";
export function Button({ children, asChild, size, variant, ...props }) { return asChild ? children : React.createElement("button", props, children); }
`],
  ["@/components/ui/input", `import React from "react"; export function Input({ containerClassName, size, variant, ...p }) { return React.createElement("input", p); }`],
  ["@/components/ui/label", `import React from "react"; export function Label({ children, ...p }) { return React.createElement("label", p, children); }`],
  ["@/components/ui/select", `import React from "react"; export function Select({ children, containerClassName, ...p }) { return React.createElement("select", p, children); }`],
  ["../utils", `
export const fetchManagedAccount = async () => ({ id: "acct-1", name: "Acme" });
export const fetchManagedDomains = async () => [{ id: "d1", hostname: "example.com" }];
export const fetchManagedMailboxes = (...a) => globalThis.__fetchMailboxes(...a);
export const removeManagedMailbox = (...a) => globalThis.__removeMailbox(...a);
export const addManagedMailbox = async () => {};
export const getMailboxAddress = (m) => m.localPart + "@" + m.hostname;
`],
]);

await build({
  stdin: {
    contents: readFileSync(join(root, "src/app/(admin)/accounts/[id]/mailboxes/page.tsx"), "utf8"),
    sourcefile: "page.tsx",
    resolveDir: join(root, "src/app/(admin)/accounts/[id]/mailboxes"),
    loader: "tsx",
  },
  outfile: join(temp, "page.mjs"),
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  packages: "external",
  external: ["react", "react-dom", "react-dom/*"],
  alias: { "@": join(root, "src") },
  plugins: [{
    name: "mailbox-remove-stubs",
    setup(b) {
      b.onResolve({ filter: /.*/ }, args => mock.has(args.path) ? { path: args.path, namespace: "stub" } : undefined);
      b.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: mock.get(args.path), loader: "tsx" }));
    },
  }],
  logLevel: "silent",
});
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Page } = await import(pathToFileURL(join(temp, "page.mjs")).href);

const mailbox = { id: "mb-1", localPart: "sales", displayName: null, domainId: "d1", hostname: "example.com" };
let removed;
let loads;
beforeEach(() => {
  removed = [];
  loads = 0;
  globalThis.__confirmed = [];
  globalThis.__removeMailbox = async id => { removed.push(id); };
  globalThis.__fetchMailboxes = async () => { loads++; return removed.length ? [] : [mailbox]; };
});

async function renderPage(t) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  t.after(async () => { await act(async () => reactRoot.unmount()); container.remove(); });
  await act(async () => { reactRoot.render(createElement(Page)); });
  return container;
}
const click = async button => act(async () => { button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

test("cancelling the confirmation removes nothing", async t => {
  globalThis.__confirmAnswer = false;
  const container = await renderPage(t);
  const button = container.querySelector('button[aria-label="account.mailboxes.removeInbox: sales@example.com"]');
  assert.ok(button, "trash button names the address");
  const loadsBefore = loads;
  await click(button);
  assert.deepEqual(globalThis.__confirmed, ["mailbox.deleteConfirm:sales@example.com"]);
  assert.deepEqual(removed, []);
  assert.equal(loads, loadsBefore, "list is not reloaded");
  assert.ok(container.textContent.includes("sales@example.com"), "mailbox is still listed");
  assert.equal(container.querySelector('[role="status"]'), null, "no message shown");
});

test("confirming removes the mailbox once and reloads the list", async t => {
  globalThis.__confirmAnswer = true;
  const container = await renderPage(t);
  const loadsBefore = loads;
  await click(container.querySelector('button[aria-label^="account.mailboxes.removeInbox"]'));
  assert.deepEqual(removed, ["mb-1"]);
  assert.equal(loads, loadsBefore + 1);
  assert.ok(!container.textContent.includes("sales@example.com"), "mailbox is gone from the list");
});
