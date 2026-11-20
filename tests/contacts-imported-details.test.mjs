import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-contact-details-ui-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			import { createElement } from "react";
			import { renderToStaticMarkup } from "react-dom/server";
			import { ContactImportedDetails } from "./src/components/contacts/contact-imported-details";
			export const render = (details, address = "jane@example.com") => renderToStaticMarkup(createElement(ContactImportedDetails, { details, address }));
		`,
		resolveDir: root,
		loader: "tsx",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
	alias: { "@": join(root, "src") },
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const { render } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("nothing imported renders nothing", () => {
	assert.equal(render(undefined), "");
	assert.equal(render({}), "");
	assert.equal(render({ emails: ["jane@example.com"] }), "");
});

test("imported details render as labelled plain-text rows", () => {
	const html = render({
		emails: ["jane@example.com", "j@work.co"], organization: "Acme", title: "CEO", birthday: "--05-01",
		phones: [{ type: "cell", value: "+1 555 0100" }], addresses: [{ type: "home", formatted: "1 Main St" }], note: "line one\nline two",
	});
	for (const text of ["<dl", "Organization", "Acme · CEO", "Birthday", "May 1", "Phone", "+1 555 0100", "cell", "Other addresses", "j@work.co", "Address", "1 Main St", "Note", "line one\nline two"]) assert.ok(html.includes(text), text);
	assert.ok(!html.includes(">jane@example.com<"), "the contact's own address is not repeated");
	assert.ok(!html.includes("<a "), "no links are made from imported text");
});

test("imported text is escaped, never markup", () => {
	const html = render({ organization: "<img src=x onerror=alert(1)>", note: "<script>alert(1)</script>", phones: [{ type: "<b>", value: "javascript:alert(1)" }] });
	assert.ok(!html.includes("<img"));
	assert.ok(!html.includes("<script"));
	assert.ok(!html.includes("<b>"));
	assert.ok(html.includes("&lt;script&gt;"));
	assert.ok(!html.includes("href"));
});

test("the list is valid: every group inside <dl> is a div holding only dt and dd, including the wide note row", () => {
	const html = render({ organization: "Acme", phones: [{ type: "", value: "1" }], note: "n" });
	assert.ok(!/<div[^>]*><div/.test(html), "no div directly inside a div");
	assert.equal((html.match(/<dt/g) ?? []).length, 3);
	assert.equal((html.match(/<div/g) ?? []).length, 3);
	assert.match(html, /<div class="[^"]*sm:col-span-2[^"]*"><dt/);
});
