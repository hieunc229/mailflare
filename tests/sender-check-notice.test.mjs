import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-sender-notice-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			import { createElement } from "react";
			import { renderToStaticMarkup } from "react-dom/server";
			import { SenderCheckNotice } from "./src/components/messages/sender-check-notice";
			export function render(message, open = false, authentication = null) {
				globalThis.testSenderAuthentication = authentication;
				return renderToStaticMarkup(createElement(SenderCheckNotice, {
					message, detailsOpen: open, onViewDetails() {}, announce: true,
				}));
			}
		`,
		resolveDir: root,
		loader: "tsx",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
	plugins: [{
		name: "authentication-state",
		setup(builder) {
			builder.onLoad({ filter: /\/use-message-authentication\.ts$/ }, () => ({
				contents: "export function useMessageAuthentication() { return { authentication: globalThis.testSenderAuthentication }; }",
				loader: "ts",
			}));
		},
	}],
});

const { render } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
const message = { id: "test", direction: "inbound", fromAddr: '"security@bank.test" <alerts@other.test>', replyTo: "help@third.test" };

test("sender notice is one compact disclosure without duplicated warning reasons", () => {
	const html = render(message);
	assert.match(html, /<button[^>]*aria-expanded="false"/);
	assert.match(html, /Sender checks need attention/);
	assert.doesNotMatch(html, /<ul|<li|sender name contains|Replies to this message|Review sender details|Be cautious/);
});

test("sender notice stays available when details are open", () => {
	const html = render(message, true);
	assert.match(html, /<button[^>]*aria-expanded="true"/);
	assert.match(html, /rotate-180/);
});

test("clean messages retain an empty live region for late authentication warnings", () => {
	const clean = { ...message, fromAddr: "help@example.test", replyTo: null };
	assert.equal(render(clean), '<div role="status"></div>');
	assert.match(render(clean, false, { available: true, dmarc: { status: "FAIL" } }), /<button/);
	assert.doesNotMatch(render({ ...message, direction: "outbound" }), /<button/);
});
