import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-review-behavior-"));
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

test("agent review does not get invalidated by autosave, and cancellation resumes autosave", async t => {
  const requests = [];
  let revision = 4;
  globalThis.__reviewTestDraft = async () => ({
    id: "draft-1", mailboxId: mailbox.id, fromAddr: '"Tester" <tester@example.com>',
    toAddr: "recipient@example.net", ccAddr: null, bccAddr: null,
    subject: "Initial subject", htmlBody: "<p>Initial body</p>", textBody: "Initial body",
    inReplyTo: null, references: null, threadId: null, attachments: [],
    agent: { revision, origin: "chat", scheduledAt: null },
  });
  globalThis.__reviewTestFetch = async (url, options = {}) => {
    const method = options.method || "GET";
    requests.push({ url, method, payload: options.body ? JSON.parse(options.body) : null });
    if (url === "/api/attachment-policy") return response({ maxMb: 25, cloudThresholdBytes: 3000000 });
    if (url === "/api/drafts/draft-1" && method === "PATCH") {
      revision++;
      return response({ draft: { id: "draft-1" } });
    }
    if (url === "/api/agent/approvals" && method === "POST") {
      return response({ approvalId: "approval-1", snapshot: {
        from: "tester@example.com", to: "recipient@example.net", cc: null, bcc: null,
        subject: "Initial subject", text: "Initial body", html: null, attachments: [], scheduledAt: null,
      } });
    }
    throw new Error("Unexpected route: " + method + " " + url);
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  t.after(async () => { await act(async () => reactRoot.unmount()); container.remove(); });

  await act(async () => { reactRoot.render(createElement(ComposeForm, { draftIdToLoad: "draft-1" })); });
  assert.ok(container.querySelector('input[id="page-subject"]'), "loaded draft has a subject");
  assert.ok(container.querySelector('form'), "composer form renders");
  await delay(1100);
  requests.length = 0;

  await act(async () => {
    container.querySelector("form").dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true })
    );
  });
  assert.ok(container.querySelector('[data-review="approval-1"]'), "send review opens");
  const reviewed = requests.find(x => x.url === "/api/agent/approvals");
  assert.ok(reviewed, "review should request a snapshot");
  assert.equal(reviewed.payload.expectedRevision, revision, "review owns current revision");

  await delay(1200);
  const patchCount = requests.filter(x => x.url === "/api/drafts/draft-1" && x.method === "PATCH").length;
  assert.equal(patchCount, 1, "no extra PATCH may invalidate an issued review snapshot");
  assert.equal(revision, reviewed.payload.expectedRevision, "reviewed revision remains stable");

  await act(async () => { container.querySelector("[data-cancel-review]").click(); });
  assert.equal(container.querySelector("[data-review]"), null, "cancel closes review");
  const input = container.querySelector('input[id="page-subject"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "Edited after cancel");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await delay(1200);
  assert.equal(requests.filter(x => x.url === "/api/drafts/draft-1" && x.method === "PATCH").length, 2,
    "a subsequent user edit saves normally after cancelling review");
});
