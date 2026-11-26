import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-compose-insert-link-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MutationObserver"]) {
	globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
document.queryCommandState = () => false;
document.queryCommandValue = () => "";

await build({
	entryPoints: [join(root, "src/components/compose/rich-text-editor.tsx")],
	outfile: join(outDir, "editor.mjs"),
	bundle: true,
	platform: "browser",
	format: "esm",
	external: ["react", "react-dom", "react-dom/*"],
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RichTextEditor } = await import(pathToFileURL(join(outDir, "editor.mjs")).href);

async function setup(t, selected = false) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	t.after(async () => {
		await act(async () => reactRoot.unmount());
		container.remove();
	});
	let submits = 0;
	const commands = [];
	document.execCommand = (command, _showUi, value) => {
		commands.push({ command, value, selection: window.getSelection().toString() });
		return true;
	};
	await act(async () => {
		reactRoot.render(createElement("form", {
			onSubmit(event) {
				event.preventDefault();
				submits++;
			},
		}, createElement(RichTextEditor, { value: "Read this", onChange() {} })));
	});
	const editor = container.querySelector('[role="textbox"]');
	editor.focus();
	const range = document.createRange();
	range.setStart(editor.firstChild, selected ? 0 : 9);
	range.setEnd(editor.firstChild, 9);
	window.getSelection().removeAllRanges();
	window.getSelection().addRange(range);
	await act(async () => container.querySelector('[aria-label="Insert link"]').click());
	const input = container.querySelector('input[placeholder="https://example.com"]');
	assert.ok(input);
	assert.equal(container.querySelectorAll("form").length, 1, "the popup must not nest a form inside the composer");
	return {
		commands,
		async fill(value) {
			await act(async () => {
				Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
				input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			});
		},
		async apply(key) {
			let event;
			await act(async () => {
				if (key) {
					event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
					input.dispatchEvent(event);
				} else {
					Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Apply").click();
				}
			});
			assert.equal(submits, 0, "inserting a link must not submit the composer");
			assert.equal(container.querySelector('input[placeholder="https://example.com"]'), null, "the popup closes");
			return event;
		},
	};
}

test("Apply inserts a URL at the caret without submitting the compose form", async (t) => {
	const popup = await setup(t);
	await popup.fill(" example.com ");
	await popup.apply();
	assert.deepEqual(popup.commands, [{ command: "insertHTML", value: '<a href="https://example.com">https://example.com</a>', selection: "" }]);
});

test("Enter links the saved text selection and prevents implicit form submission", async (t) => {
	const popup = await setup(t, true);
	await popup.fill("https://example.com/read");
	const event = await popup.apply("Enter");
	assert.equal(event.defaultPrevented, true);
	assert.deepEqual(popup.commands, [{ command: "createLink", value: "https://example.com/read", selection: "Read this" }]);
});

test("Apply with a blank URL closes the popup without inserting or submitting", async (t) => {
	const popup = await setup(t);
	await popup.fill("   ");
	await popup.apply();
	assert.deepEqual(popup.commands, []);
});

test("Escape cancels link insertion", async (t) => {
	const popup = await setup(t);
	await popup.fill("https://example.com");
	await popup.apply("Escape");
	assert.deepEqual(popup.commands, []);
});

async function setupHtmlComposer(t, initialHtml = "") {
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	const { Fragment, useState } = await import("react");
	t.after(async () => {
		await act(async () => root.unmount());
		container.remove();
	});
	function Composer() {
		const [body, setBody] = useState({ value: initialHtml });
		return createElement(Fragment, null,
			createElement(RichTextEditor, {
				value: body.value, valueIsSource: body.fromSource, enableHtmlComposition: true,
				onChange: (value, fromSource) => setBody({ value, fromSource }),
			}),
			createElement("output", null, body.value),
		);
	}
	await act(async () => root.render(createElement(Composer)));
	return { container, saved: () => container.querySelector("output").textContent };
}

test("rich clipboard paste preserves email markup and keeps unsafe content out of the editable DOM", async (t) => {
	const { container, saved } = await setupHtmlComposer(t);
	const editor = container.querySelector('[role="textbox"]');
	document.execCommand = (command, _showUi, value) => {
		assert.equal(command, "insertHTML");
		editor.insertAdjacentHTML("beforeend", value);
		return true;
	};
	const paste = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(paste, "clipboardData", { value: {
		getData: type => type === "text/html"
			? '<table><tr><td style="color:red"><b>Hello</b><img src="https://example.com/image.png" onerror="bad()"><script>bad()</script></td></tr></table>'
			: "Hello",
	} });
	await act(async () => editor.dispatchEvent(paste));
	assert.ok(paste.defaultPrevented);
	assert.equal(editor.querySelector("td").style.color, "red");
	assert.equal(editor.querySelector("b").textContent, "Hello");
	assert.equal(editor.querySelector("img").hasAttribute("src"), false);
	assert.match(saved(), /https:\/\/example.com\/image.png/);
	assert.doesNotMatch(saved(), /<(script|iframe)|onerror/i);
});

test("HTML mode previews live edits safely and restores the visual editor", async (t) => {
	const { container, saved } = await setupHtmlComposer(t);
	const toggle = container.querySelector('[aria-label="HTML mode"]');
	assert.ok(toggle);
	await act(async () => toggle.click());
	const source = container.querySelector("textarea");
	assert.ok(source);
	const markup = '<p style="color: red">Hello &amp; welcome</p><a href="https://example.com/">Link</a><img src="https://example.com/image.png"><script>bad()</script>';
	await act(async () => {
		Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(source, markup);
		source.dispatchEvent(new Event("input", { bubbles: true }));
	});
	assert.equal(source.value, markup);
	assert.equal(saved(), markup, "source edits synchronously reach the composer without normalization");
	await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
	const preview = Array.from(container.querySelectorAll("div")).find(element => element.shadowRoot)?.shadowRoot;
	assert.equal(preview?.querySelector("p")?.textContent, "Hello & welcome");
	assert.ok(preview?.querySelector("a[inert]"));
	assert.equal(preview?.querySelector("img")?.hasAttribute("src"), false);
	assert.equal(preview?.querySelector("script"), null);
	const previewRegion = container.querySelector('section[aria-label="Preview"]');
	assert.ok(previewRegion.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING);
	const highlighted = container.querySelector('pre[aria-hidden="true"] code');
	assert.equal(highlighted.textContent.trimEnd(), markup);
	assert.ok(Array.from(highlighted.querySelectorAll("span")).some(span => span.textContent === "style"));
	assert.ok(Array.from(highlighted.querySelectorAll("span")).some(span => span.textContent === '"color: red"'));
	assert.equal(highlighted.querySelector("script"), null);
	await act(async () => toggle.click());
	assert.equal(container.querySelector("textarea"), null);
	assert.equal(container.querySelector('[role="textbox"] p').textContent, "Hello & welcome");
	assert.equal(container.querySelector('[role="textbox"] script'), null);
});

test("HTML mode inserts formatted clipboard content into the selected source range", async (t) => {
	const { container, saved } = await setupHtmlComposer(t, '<p class="existing-email-body">Replace me</p>');
	await act(async () => container.querySelector('[aria-label="HTML mode"]').click());
	assert.equal(container.querySelector(".existing-email-body"), null, "visual markup must only render inside the live preview shadow root");
	const source = container.querySelector("textarea");
	const selectionStart = source.value.indexOf("Replace me");
	source.setSelectionRange(selectionStart, selectionStart + "Replace me".length);
	const paste = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(paste, "clipboardData", { value: {
		getData: type => type === "text/html" ? "<strong>Example</strong>" : "Example",
	} });
	await act(async () => source.dispatchEvent(paste));
	assert.ok(paste.defaultPrevented);
	assert.equal(source.value, '<p class="existing-email-body"><strong>Example</strong></p>');
	assert.equal(saved(), source.value);
});

test("HTML mode numbers blank and trailing lines and scrolls the gutter vertically", async (t) => {
	const { container } = await setupHtmlComposer(t);
	await act(async () => container.querySelector('[aria-label="HTML mode"]').click());
	const source = container.querySelector("textarea");
	const gutter = container.querySelector('pre[aria-hidden="true"]:has(span)');
	assert.ok(gutter);
	assert.equal(gutter.textContent, "1");
	await act(async () => {
		Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(source, "<p>First</p>\n\n<p>Third</p>\n");
		source.dispatchEvent(new Event("input", { bubbles: true }));
	});
	assert.equal(gutter.textContent, "1\n2\n3\n4");
	await act(async () => {
		source.scrollTop = 24;
		source.scrollLeft = 12;
		source.dispatchEvent(new Event("scroll"));
	});
	assert.equal(gutter.querySelector("span").style.transform, "translateY(-24px)");
});

test("switching to Visual and back preserves the original HTML source", async (t) => {
	const { container } = await setupHtmlComposer(t);
	const toggle = container.querySelector('[aria-label="HTML mode"]');
	await act(async () => toggle.click());
	const source = '<!DOCTYPE html>\n<html lang="en">\n<body style="color: red">\n  <p>Hello</p>\n</body>\n</html>';
	const textarea = container.querySelector("textarea");
	await act(async () => {
		Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(textarea, source);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => toggle.click());
	const visual = container.querySelector('[role="textbox"]');
	assert.equal(visual.querySelector("p").textContent, "Hello");
	await act(async () => {
		visual.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
		toggle.click();
	});
	assert.equal(container.querySelector("textarea").value, source);
});

test("source copied from a code editor keeps its leading HTML comment", async (t) => {
	const { container } = await setupHtmlComposer(t);
	await act(async () => container.querySelector('[aria-label="HTML mode"]').click());
	const source = container.querySelector("textarea");
	const paste = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(paste, "clipboardData", { value: {
		getData: type => type === "text/html" ? "<span>&lt;!-- Email --&gt;</span>" : "<!-- Email -->\n<p>Hello</p>",
	} });
	await act(async () => source.dispatchEvent(paste));
	assert.equal(paste.defaultPrevented, false, "the textarea should insert text/plain natively");
});
