import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, beforeEach } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Turning auto-reply off has to be saveable, not only turning it on.

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-auto-reply-form-"));
after(() => rmSync(temp, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "HTMLInputElement", "HTMLTextAreaElement"]) {
  globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mock = new Map([
  ["@/components/language-provider", `export function useLanguage() { return { t(key) { return key; } }; }`],
  ["@/components/mailbox-provider", `export function useSelectedMailbox() { return globalThis.__autoReplyTestMailbox; }`],
  ["@/components/mailbox-provider-utils", `export function clearMailboxesCache() {}`],
  ["@/lib/auth/client", `export function authFetch(...args) { return globalThis.__autoReplyTestFetch(...args); }`],
  ["@/lib/http/client-error", `export function requestError(message) { return new Error(message); }`],
]);

const genericUI = `
import React from "react";
export function Button({children, size, variant, pill, ...props}) {return React.createElement("button",props,children);}
export const Input = React.forwardRef(function Input({size,variant,containerClassName,...props},ref){return React.createElement("input",{...props,ref});});
export const Textarea = React.forwardRef(function Textarea(props,ref){return React.createElement("textarea",{...props,ref});});
export function Label({children,...props}){return React.createElement("label",props,children);}
export function Checkbox(props){return React.createElement("input",{type:"checkbox",...props});}
`;

// The real form, the real settings/utils.ts save call and the real Switch; only the network,
// translations, mailbox provider and plain UI pieces are stubbed.
await build({
  stdin: {
    contents: readFileSync(join(root, "src/components/settings/mailbox-auto-reply-form.tsx"), "utf8"),
    sourcefile: "mailbox-auto-reply-form.tsx",
    resolveDir: join(root, "src/components/settings"),
    loader: "tsx",
  },
  outfile: join(temp, "form.mjs"),
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  packages: "external",
  external: ["react", "react-dom", "react-dom/*"],
  alias: { "@": join(root, "src") },
  plugins: [{
    name: "auto-reply-test-stubs",
    setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        if (mock.has(args.path)) return { path: args.path, namespace: "auto-reply-test-stub" };
        if (/^@\/components\/ui\//.test(args.path)) return { path: args.path, namespace: "auto-reply-ui-stub" };
        return undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "auto-reply-test-stub" }, args => ({ contents: mock.get(args.path), loader: "tsx" }));
      b.onLoad({ filter: /.*/, namespace: "auto-reply-ui-stub" }, () => ({ contents: genericUI, loader: "tsx" }));
    },
  }],
  logLevel: "silent",
});
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MailboxAutoReplyForm } = await import(pathToFileURL(join(temp, "form.mjs")).href);

const requests = [];
globalThis.__autoReplyTestFetch = async (url, options = {}) => {
  const method = options.method || "GET";
  const payload = options.body ? JSON.parse(options.body) : null;
  requests.push({ url, method, payload });
  if (url === "/api/mailboxes/mailbox-1" && method === "PATCH") return response({ mailbox: { id: "mailbox-1", ...payload } });
  return response({ error: "Unexpected route" }, 500);
};
beforeEach(() => { requests.length = 0; });

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

async function renderForm(t, autoReply) {
  const mailbox = {
    id: "mailbox-1", localPart: "tester", hostname: "example.com", permission: "full_access",
    autoReplyEnabled: autoReply.enabled, autoReplySubject: autoReply.subject, autoReplyBody: autoReply.body,
  };
  const updates = [];
  globalThis.__autoReplyTestMailbox = { selectedMailbox: mailbox, setSelectedMailbox(next) { updates.push(next); }, isLoading: false };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  t.after(async () => {
    await act(async () => reactRoot.unmount());
    container.remove();
  });
  await act(async () => { reactRoot.render(createElement(MailboxAutoReplyForm)); });
  return { container, updates };
}

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 10)); // let the save request finish
  });
}

test("auto-reply that is switched off can be saved", async t => {
  const { container, updates } = await renderForm(t, { enabled: true, subject: "Out of office", body: "Back on Monday." });
  const toggle = container.querySelector('[role="switch"]');
  assert.equal(toggle.getAttribute("aria-checked"), "true");

  await click(toggle);
  assert.equal(toggle.getAttribute("aria-checked"), "false", "the switch is off");
  const save = container.querySelector('button[type="submit"]');
  assert.ok(save, "a Save button is shown while the switch is off");
  assert.equal(save.disabled, false, "the change can be saved");

  await click(save);
  assert.deepEqual(requests, [{
    url: "/api/mailboxes/mailbox-1",
    method: "PATCH",
    payload: { autoReplyEnabled: false, autoReplySubject: "Out of office", autoReplyBody: "Back on Monday." },
  }]);
  assert.equal(updates.at(-1)?.autoReplyEnabled, false, "the mailbox is updated");
  assert.match(container.textContent, /common\.saved/, "the form says it saved");
  assert.equal(container.querySelector('button[type="submit"]').disabled, true, "nothing is left to save");
});

test("switching auto-reply on shows its fields and still asks for a message", async t => {
  const { container } = await renderForm(t, { enabled: false, subject: "Out of office", body: "" });
  assert.equal(container.querySelector("#autoReplyBody"), null, "the message box is hidden while auto-reply is off");

  await click(container.querySelector('[role="switch"]'));
  assert.ok(container.querySelector("#autoReplySubject"), "the subject box shows once auto-reply is on");
  assert.ok(container.querySelector("#autoReplyBody"), "the message box shows once auto-reply is on");

  await click(container.querySelector('button[type="submit"]'));
  assert.deepEqual(requests, [], "nothing is saved without a message");
  assert.match(container.textContent, /settings\.autoReply\.needMessage/);
});
