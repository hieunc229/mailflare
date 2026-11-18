import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, beforeEach } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// A new message that still holds only the mailbox signature must not be saved
// as a draft, whether the signature is plain text or HTML.

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-signature-autosave-"));
after(() => rmSync(temp, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
// DOMParser puts HTML signatures on the same path they take in a browser.
for (const key of ["window", "document", "DOMParser", "HTMLElement", "Element", "Node", "Event", "HTMLInputElement", "File", "FormData"]) {
  globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mock = new Map([
  ["next/navigation", `export function useRouter() { return { push() {}, replace() {} }; }`],
  ["@/components/language-provider", `export function useLanguage() { return { t(key) { return key; } }; }`],
  ["@/components/mailbox-provider", `export function useSelectedMailbox() { return globalThis.__signatureTestMailboxes; }`],
  ["@/components/compose/compose-context", `export function useCompose() { return { showNotice() {} }; }`],
  ["@/lib/auth/client", `export function authFetch(...args) { return globalThis.__signatureTestFetch(...args); }`],
  ["@/lib/messages/detail-cache", `export function clearMessageDetailCache() {}`],
  ["@/components/compose/utils", `
export async function fetchDraft() { throw new Error("No draft to load in this test"); }
export function formatAttachmentSize(bytes) { return String(bytes); }
export function buildSendFormData() { throw new Error("No send in this test"); }
`],
  ["@/components/sidebar-mobile-utils", `export function useIsMobile() { return false; }`],
  ["@/components/compose/use-sheet-viewport", `export function useSheetViewport() {}`],
  ["@/components/compose/rich-text-editor", `
import React from "react";
export function RichTextEditor({ value, onChange, toolbarStart, toolbarEnd, footerContent, disabled }) {
  return React.createElement("div", {}, toolbarStart,
    React.createElement("textarea", { "data-body": "yes", value: value || "", onChange: event => onChange(event.target.value), disabled }),
    toolbarEnd, footerContent);
}
`],
  ["@/components/compose/recipient-input", `export function RecipientInput() { return null; }`],
  ["@/components/compose/schedule-send-menu", `export function ScheduleSendMenu() { return null; }`],
  ["@/components/agent/send-review", `export function SendReview() { return null; }`],
]);

const genericUI = `
import React from "react";
export function Button({children, size, variant, pill, ...props}) {return React.createElement("button",props,children);}
export const Input = React.forwardRef(function Input({size,variant,containerClassName,...props},ref){return React.createElement("input",{...props,ref});});
export function Label({children,...props}){return React.createElement("label",props,children);}
export function Select({children,containerClassName,...props}){return React.createElement("select",props,children);}
export function Tooltip({children}){return children;}
`;

await build({
  stdin: {
    contents: readFileSync(process.env.MAILFLARE_TEST_COMPOSE_SOURCE || join(root, "src/components/compose/compose-form.tsx"), "utf8"),
    sourcefile: "compose-form.tsx",
    resolveDir: join(root, "src/components/compose"),
    loader: "tsx",
  },
  outfile: join(temp, "compose.mjs"),
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  packages: "external",
  external: ["react", "react-dom", "react-dom/*", "lucide-react"],
  alias: { "@": join(root, "src") },
  plugins: [{
    name: "signature-test-stubs",
    setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        const relativeMocks = {
          "./utils": "@/components/compose/utils",
          "./rich-text-editor": "@/components/compose/rich-text-editor",
          "./recipient-input": "@/components/compose/recipient-input",
          "./schedule-send-menu": "@/components/compose/schedule-send-menu",
          "./use-sheet-viewport": "@/components/compose/use-sheet-viewport",
        };
        if (args.importer.endsWith("compose-form.tsx") && relativeMocks[args.path])
          return { path: relativeMocks[args.path], namespace: "signature-test-stub" };
        if (mock.has(args.path)) return { path: args.path, namespace: "signature-test-stub" };
        if (/^@\/components\/ui\//.test(args.path)) return { path: args.path, namespace: "signature-ui-stub" };
        return undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "signature-test-stub" }, args => ({ contents: mock.get(args.path), loader: "tsx" }));
      b.onLoad({ filter: /.*/, namespace: "signature-ui-stub" }, () => ({ contents: genericUI, loader: "tsx" }));
    },
  }],
  logLevel: "silent",
});
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ComposeForm } = await import(pathToFileURL(join(temp, "compose.mjs")).href);

const signatures = {
  HTML: '<div style="font-family: Arial, sans-serif"><strong>Tester</strong><br>Example Inc. · <a href="https://example.com">example.com</a></div>',
  "plain-text": "Tester\nExample Inc.",
  '"-- " plain-text': "-- \nTester\nExample Inc.",
};

const requests = [];
globalThis.__signatureTestFetch = async (url, options = {}) => {
  const method = options.method || "GET";
  requests.push({ url, method, payload: options.body ? JSON.parse(options.body) : null });
  if (url === "/api/attachment-policy") return response({ maxMb: 25, cloudThresholdBytes: 3000000 });
  if (url === "/api/drafts" && method === "POST") return response({ draft: { id: "draft-1" } });
  if (url === "/api/drafts/draft-1" && method === "PATCH") return response({ draft: { id: "draft-1" } });
  return response({ error: "Unexpected route" }, 500);
};
beforeEach(() => { requests.length = 0; });
const draftRequests = () => requests.filter(request => request.url.startsWith("/api/drafts"));

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}
async function delay(milliseconds) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, milliseconds)); });
}

async function openNewMessage(t, signature) {
  const mailbox = { id: "mailbox-1", localPart: "tester", hostname: "example.com", displayName: "Tester",
    senderAddresses: ["tester@example.com"], signature };
  globalThis.__signatureTestMailboxes = { selectedMailbox: mailbox, setSelectedMailbox() {}, mailboxes: [mailbox] };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  let open = true;
  async function close() {
    if (!open) return;
    open = false;
    await act(async () => reactRoot.unmount());
    container.remove();
  }
  t.after(close);
  await act(async () => { reactRoot.render(createElement(ComposeForm, {})); });
  const body = container.querySelector("textarea[data-body]");
  assert.match(body.value, /Example Inc\./, "the composer starts with the signature");
  return { body, close };
}

for (const [kind, signature] of Object.entries(signatures)) {
  test(`an untouched new message with a ${kind} signature leaves no draft`, async t => {
    const closedAtOnce = await openNewMessage(t, signature);
    await closedAtOnce.close(); // closing flushes a pending autosave
    const leftOpen = await openNewMessage(t, signature);
    await delay(1100); // past the 900 ms autosave delay
    await leftOpen.close();
    await delay(50);
    assert.deepEqual(draftRequests(), []);
  });
}

for (const kind of ["HTML", "plain-text"]) {
  test(`a typed message with a ${kind} signature still autosaves`, async t => {
    const { body } = await openNewMessage(t, signatures[kind]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(body, `<div>Hello there</div>${body.value}`);
      body.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await delay(1100);
    const drafts = draftRequests();
    assert.equal(drafts.length, 1, "one draft is saved");
    assert.equal(drafts[0].method, "POST");
    assert.match(drafts[0].payload.text, /Hello there/);
    assert.match(drafts[0].payload.text, /Example Inc\./, "the signature stays in the draft");
  });
}
