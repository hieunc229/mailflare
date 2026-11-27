import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-print-styles-"));
const outfile = join(outDir, "print.mjs");
after(() => rmSync(outDir, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.ResizeObserver = dom.window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.testDom = dom;

// The print stylesheet (src/app/globals.css @media print) hangs entirely on
// semantic hooks — data-print-* attributes, mf-print-*/email-html-* classes,
// and the upstream article[data-message-id] gate. These tests render the real
// components that own those hooks and assert each selector still lands on a
// live element, so a markup change cannot leave the print CSS pointed at dead
// selectors while the diff looks clean.
await build({
	stdin: {
		contents: `
			import { createElement } from "react";
			import { createRoot } from "react-dom/client";
			import { act } from "react";
			import { LanguageProvider } from "./src/components/language-provider";
			import { MessageAttachmentCard } from "./src/components/message-attachment-card";
			import { ContactDetailsTrigger } from "./src/components/contacts/contact-details";
			import { QuotedEmailToggle } from "./src/components/messages/quoted-email-toggle";
			import { EmailHtmlRenderer } from "./src/components/messages/email-html-renderer";
			export async function render(element) {
				document.body.replaceChildren();
				const container = document.createElement("div");
				document.body.appendChild(container);
				const root = createRoot(container);
				await act(async () => {
					root.render(createElement(LanguageProvider, { initialLocale: "en" }, element));
				});
				await act(async () => {});
				return container;
			}
			export { MessageAttachmentCard, ContactDetailsTrigger, QuotedEmailToggle, EmailHtmlRenderer, createElement };
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
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
	loader: { ".js": "jsx" },
	plugins: [{
		name: "runtime-stubs",
		setup(builder) {
			builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
		},
	}],
});

const { render, MessageAttachmentCard, ContactDetailsTrigger, QuotedEmailToggle, EmailHtmlRenderer, createElement } = await import(pathToFileURL(outfile).href);

const css = readFileSync(join(root, "src/app/globals.css"), "utf8");
const printBlock = css.slice(css.indexOf("@media print"), css.indexOf("@media (prefers-reduced-motion"));
const read = (path) => readFileSync(join(root, path), "utf8");

const iconAttachment = {
	contentId: null,
	disposition: "attachment",
	filename: "invoice.pdf",
	id: "att-1",
	messageId: "msg-1",
	size: 1024,
	type: "application/pdf",
};

test("mf-print-attachment and mf-print-thumb live on the rendered attachment card", async () => {
	const container = await render(createElement(MessageAttachmentCard, { attachment: iconAttachment, messageId: "msg-1", onPreview: () => {} }));
	assert.ok(container.querySelector("button.mf-print-attachment"), "the card button carries mf-print-attachment");
	assert.ok(container.querySelector("button.mf-print-attachment .mf-print-thumb"), "the icon thumbnail carries mf-print-thumb");
});

test("mf-print-text lives on the rendered contact trigger button", async () => {
	const container = await render(createElement(ContactDetailsTrigger, { mailboxId: "mb-1", address: "a@b.c", name: "Alice" }));
	assert.ok(container.querySelector("button.mf-print-text"), "the name trigger is a button.mf-print-text");
});

test("the quote toggle renders .email-quote-toggle > summary and the renderer hooks", async () => {
	const container = await render(createElement(QuotedEmailToggle, { html: "<p>quoted</p>" }));
	assert.ok(container.querySelector("details.email-quote-toggle > summary"), "the light-DOM toggle matches the print rule");
	assert.ok(container.querySelector(".email-html-renderer .email-html-host"), "the renderer keeps its print hook classes");
});

test("the remote-content affordance renders .email-html-remote", async () => {
	const container = await render(createElement(EmailHtmlRenderer, { html: '<p>hi</p><img src="https://remote.example/pixel.png">' }));
	assert.ok(container.querySelector(".email-html-remote"), "the blocked-remote bar keeps its print hook");
});

test("the shadow print rules live inside the renderer's own style block", () => {
	const source = read("src/components/messages/email-html-renderer.tsx");
	assert.match(source, /@media print \{[\s\S]*:host \{ filter:none !important; contain:none !important/, "the host resets print containment and inversion");
	assert.match(source, /\.email-quote-toggle > summary \{ display:none !important; \}/, "only the summary hides inside the shadow root");
	assert.match(source, /background:#fff !important; color:#111 !important/, "the shadow canvas prints light");
});

test("every data-print-* hook exists on its new-tree host element", () => {
	const page = read("src/app/(dashboard)/inbox/[messageId]/page.tsx");
	assert.match(page, /<div data-print-hide className=\{clsx\("flex py-2 h-12 items-center/, "the reader toolbar carries data-print-hide");
	assert.match(page, /<div ref=\{scrollRef\} data-print-scroll/, "the reader scroller carries data-print-scroll");
	assert.match(page, /<article data-message-id=\{message\.id\}/, "the reader article keeps the data-message-id gate");

	const layout = read("src/components/messages/message-split-layout.tsx");
	assert.equal(layout.match(/data-print-reset/g)?.length, 2, "the split grid and the reader section carry data-print-reset");
	assert.match(layout, /<div\s+data-print-hide\s+className=\{`relative h-full min-h-0 min-w-0/, "the list pane carries data-print-hide");
	assert.match(layout, /\[--reader-indent:30px\]/, "the reader section defines --reader-indent");

	for (const [file, why] of [
		["src/components/messages/conversation-notes.tsx", "notes hide"],
		["src/components/messages/mailing-list-banner.tsx", "unsubscribe banner hides"],
		["src/components/messages/scheduled-send-banner.tsx", "scheduling banner hides"],
	]) {
		assert.match(read(file), /data-print-hide/, `${file}: ${why}`);
	}

	const thread = read("src/components/messages/conversation-thread.tsx");
	assert.match(thread, /className="mf-print-card /, "the thread header carries mf-print-card");
});

test("the thread header host is div[role=button], matched by the bare .mf-print-card selector", () => {
	const thread = read("src/components/messages/conversation-thread.tsx");
	const header = thread.slice(thread.indexOf('role="button"'), thread.indexOf('role="button"') + 1200);
	assert.match(header, /className="mf-print-card /, "mf-print-card sits on the role=button div");
	assert.match(printBlock, /body:has\(\[data-message-id\]\) \.mf-print-card/, "the CSS matches the class, not a button tag that no longer exists");
	assert.doesNotMatch(printBlock, /button\.mf-print-card/, "no dead button.mf-print-card selector remains");
});

test("the print stylesheet still names every remaining screen-utility hook", () => {
	for (const [cssSelector, fileClass, sites] of [
		[".sm\\:pl-\\[78px\\]", "sm:pl-[78px]", ["src/app/(dashboard)/inbox/[messageId]/page.tsx", "src/components/messages/conversation-thread.tsx"]],
		[".sm\\:-ml-12", "sm:-ml-12", ["src/app/(dashboard)/inbox/[messageId]/page.tsx", "src/components/messages/conversation-thread.tsx"]],
		[".sm\\:pr-6", "sm:pr-6", ["src/app/(dashboard)/inbox/[messageId]/page.tsx", "src/components/messages/conversation-thread.tsx"]],
	]) {
		assert.ok(printBlock.includes(`body:has([data-message-id]) ${cssSelector}`), `${cssSelector} is styled`);
		for (const site of sites) assert.ok(read(site).includes(fileClass), `${site} still uses ${fileClass}`);
	}
});

test("the reader-indent variable is zeroed for print on the element that defines it", () => {
	const resetRule = printBlock.match(/body:has\(\[data-message-id\]\) \[data-print-reset\],[\s\S]*?\{([^}]*)\}/);
	assert.ok(resetRule, "the shared reset rule exists");
	assert.match(resetRule[1], /--reader-indent: 0 !important;/, "the avatar gutter collapses to the page margin");
});

test("a marker-free document matches none of the gated print selectors", () => {
	const blank = new JSDOM("<!doctype html><html><body><main><p>receipt</p></main></body></html>");
	assert.equal(blank.window.document.querySelector("[data-message-id]"), null, "fixture has no reader marker");
	const gated = [...printBlock.matchAll(/body:has\(\[data-message-id\]\) ([^{,]+)/g)].map((m) => m[1].trim());
	assert.ok(gated.length > 10, "the audit sees the gated rules");
	assert.match(css, /html:has\(\[data-message-id\]\) \{\s*page: reader;/, "the named reader page stays gated on the marker");
});
