import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, mock as nodeMock } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-toast-render-"));
after(() => rmSync(temp, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event", "HTMLInputElement", "File", "FormData"]) {
  globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mock = new Map([
  ["next/navigation", `
export function useRouter() { return { push() {}, replace() {} }; }
`],
  ["@/components/language-provider", `
export function useLanguage() { return { t(key) { return key; } }; }
`],
  ["@/components/mailbox-provider", `
export function useSelectedMailbox() { return globalThis.__reviewTestMailboxes; }
`],
  ["@/components/compose/compose-context", `
export function useCompose() { return { showNotice() {}, openComposer() {} }; }
`],
  ["@/lib/auth/client", `
export function authFetch(...args) { return globalThis.__reviewTestFetch(...args); }
`],
  ["@/lib/messages/detail-cache", `
export function clearMessageDetailCache() {}
`],
  ["@/components/compose/utils", `
export async function fetchDraft() { return globalThis.__reviewTestDraft(); }
export function formatAttachmentSize(bytes) { return String(bytes); }
export function buildSendFormData() { throw new Error("No direct send allowed in this test"); }
`],
  ["@/components/sidebar-mobile-utils", `
export function useIsMobile() { return false; }
`],
  ["@/components/compose/use-sheet-viewport", `
export function useSheetViewport() {}
`],
  ["@/components/compose/rich-text-editor", `
import React from "react";
export function RichTextEditor({value, onChange, toolbarStart, toolbarEnd, footerContent, disabled}) {
  return React.createElement("div", {},
    toolbarStart,
    React.createElement("textarea", { "data-body": "yes", value: value || "", onChange: event => onChange(event.target.value), disabled }),
    toolbarEnd, footerContent
  );
}
`],
  ["@/components/compose/recipient-input", `
export function RecipientInput() { return null; }
`],
  ["@/components/compose/schedule-send-menu", `
export function ScheduleSendMenu() { return null; }
`],
  ["@/components/agent/send-review", `
import React from "react";
export function SendReview({ onClose, approvalId }) {
  return React.createElement("div", { "data-review": approvalId },
    React.createElement("button", { "data-cancel-review": true, onClick: onClose }, "Cancel review")
  );
}
`],
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
    name: "review-network-and-presentation-stubs",
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
          return { path: relativeMocks[args.path], namespace: "review-test-stub" };
        if (mock.has(args.path)) return { path: args.path, namespace: "review-test-stub" };
        if (/^@\/components\/ui\//.test(args.path)) return { path: args.path, namespace: "review-ui-stub" };
        return undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "review-test-stub" }, args => ({ contents: mock.get(args.path), loader: "tsx" }));
      b.onLoad({ filter: /.*/, namespace: "review-ui-stub" }, () => ({ contents: genericUI, loader: "tsx" }));
    },
  }],
  logLevel: "silent",
});
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ComposeForm } = await import(pathToFileURL(join(temp, "compose.mjs")).href);

const mailbox = { id: "mailbox-1", localPart: "tester", hostname: "example.com", displayName: "Tester",
  senderAddresses: ["tester@example.com"], signature: "" };
globalThis.__reviewTestMailboxes = { selectedMailbox: mailbox, setSelectedMailbox() {}, mailboxes: [mailbox] };

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}
async function delay(milliseconds) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, milliseconds)); });
}

globalThis.__reviewTestFetch = async (url) => {
  if (url === "/api/attachment-policy") return response({ maxMb: 25, cloudThresholdBytes: 3000000 });
  return response({});
};

async function mountComposer(t) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  t.after(async () => { await act(async () => reactRoot.unmount()); container.remove(); });
  await act(async () => { reactRoot.render(createElement(ComposeForm, { mode: "popup" })); });
  await act(async () => { container.querySelector('button[aria-label="compose.openModal"]').click(); });
  return container;
}
// No recipient: submit shows the "no recipient" error toast.
const submit = (container) => act(async () => {
  container.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
});
const toastEl = (container) => container.querySelector('[role="alert"]');
const dismissButton = (container) => toastEl(container).querySelector('button[aria-label="promotions.toast.dismiss"]');

test("an error toast stays 15 s, then auto-hides", async (t) => {
  nodeMock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => nodeMock.timers.reset());
  const container = await mountComposer(t);
  await submit(container);
  assert.ok(toastEl(container), "error toast shown");
  await act(async () => { nodeMock.timers.tick(14000); });
  assert.ok(toastEl(container), "still visible before 15 s");
  await act(async () => { nodeMock.timers.tick(1500); });
  assert.equal(toastEl(container), null, "gone after 15 s");
});

test("Dismiss after hover clears the pause, so the next toast auto-hides", async (t) => {
  nodeMock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => nodeMock.timers.reset());
  const container = await mountComposer(t);
  await submit(container);
  await act(async () => { toastEl(container).dispatchEvent(new window.Event("pointerover", { bubbles: true })); });
  await act(async () => { nodeMock.timers.tick(20000); });
  assert.ok(toastEl(container), "hovered toast is held");
  await act(async () => { dismissButton(container).click(); });
  assert.equal(toastEl(container), null, "Dismiss removes it (no pointerleave fires for a removed node)");

  await submit(container);
  await act(async () => { nodeMock.timers.tick(15500); });
  assert.equal(toastEl(container), null, "the next toast is not stuck paused");
});

test("Escape inside the toast clears the focus hold and returns focus to the composer", async (t) => {
  nodeMock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => nodeMock.timers.reset());
  const container = await mountComposer(t);
  await submit(container);
  await act(async () => { dismissButton(container).focus(); });
  assert.equal(document.activeElement, dismissButton(container));
  await act(async () => {
    dismissButton(container).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  assert.equal(toastEl(container), null, "Escape dismisses");
  assert.equal(container.querySelector("form").getAttribute("role"), "dialog", "Escape on the toast does not also close the modal composer");
  assert.ok(container.querySelector("form").contains(document.activeElement), "focus stays inside the compose dialog");

  await submit(container);
  await act(async () => { nodeMock.timers.tick(15500); });
  assert.equal(toastEl(container), null, "the next toast is not stuck paused");
});

test("Dismiss by click keeps focus inside the dialog", async (t) => {
  const container = await mountComposer(t);
  await submit(container);
  await act(async () => { dismissButton(container).focus(); });
  await act(async () => { dismissButton(container).click(); });
  assert.ok(container.querySelector("form").contains(document.activeElement), "focus is in the composer, not <body>");
});
