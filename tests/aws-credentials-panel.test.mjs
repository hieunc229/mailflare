import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-aws-credentials-panel-"));
const outfile = join(outDir, "panel.mjs");
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.testDom = dom;

await build({
	stdin: {
		contents: `
			import { createElement } from "react";
			import { createRoot } from "react-dom/client";
			import { act } from "react";
			import { LanguageProvider } from "./src/components/language-provider";
			import Panel from "./src/app/(admin)/domains/AwsCredentialsPanel";
			import { ApiError, requestJson } from "./src/app/(admin)/domains/api";
			export { ApiError, requestJson };
			const dom = globalThis.testDom;
			export async function renderPanel() {
				// Each test gets its own mount, so panel state never leaks between them.
				document.body.replaceChildren();
				const container = document.createElement("div");
				document.body.appendChild(container);
				const root = createRoot(container);
				await act(async () => {
					root.render(createElement(LanguageProvider, { initialLocale: "en" }, createElement(Panel, { need: "sending" })));
				});
				return async function fillAndSave() {
					const inputs = container.querySelectorAll("input");
					const setValue = (input, value) => {
						const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
						setter.call(input, value);
						input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
					};
					await act(async () => {
						setValue(inputs[0], "AKIAIOSFODNN7EXAMPLE");
						setValue(inputs[1], "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
						setValue(inputs[2], "us-east-1");
					});
					await act(async () => {
						container.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
					});
				};
			}
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

const { renderPanel, requestJson, ApiError } = await import(pathToFileURL(outfile).href);
const en = JSON.parse(readFileSync(join(root, "src/lib/i18n/en.json"), "utf8"));
const AWS_IAM_POLICY_SOURCE = readFileSync(join(root, "src/lib/aws/validate.ts"), "utf8");

/** Answers the panel's calls from a queue of canned responses, recording what it was asked. */
function stubApi(responses) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), method: init?.method ?? "GET" });
		const next = responses.shift();
		if (!next) throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
		return Response.json(next.body, { status: next.status ?? 200 });
	};
	return calls;
}

const NOT_CONFIGURED = {
	status: { configured: false, source: null, region: null, accessKeyHint: null, accountId: null },
	policy: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["ses:GetAccount"], Resource: "*" }] },
};

const REFUSAL = {
	error: "These credentials work but have no SES permissions. Attach the policy shown below.",
	report: {
		accountId: "123456789012",
		arn: "arn:aws:iam::123456789012:user/mailflare",
		region: "us-east-1",
		sending: false,
		productionAccess: null,
		receivingRegion: true,
		receiving: false,
		sns: false,
		s3: false,
		missing: ["ses:GetAccount", "ses:SendEmail", "ses:DescribeActiveReceiptRuleSet"],
	},
	policy: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["ses:GetAccount", "ses:SendEmail"], Resource: "*" }] },
};

test("a save the server refuses shows the missing permissions and the IAM policy", async () => {
	stubApi([{ body: NOT_CONFIGURED }, { body: REFUSAL, status: 400 }]);
	const save = await renderPanel();
	await save();

	const details = document.querySelector("body details");
	assert.ok(details, "the missing-permission block is rendered");
	assert.equal(details.open, true, "the block is expanded so the policy is readable without a click");
	assert.match(details.textContent, /ses:GetAccount, ses:SendEmail, ses:DescribeActiveReceiptRuleSet/);
	assert.match(details.querySelector("pre").textContent, /"ses:SendEmail"/);
	assert.match(document.querySelector("body [role=alert]").textContent, /no SES permissions/);
});

test("a refusal body that carries no report leaves the panel as it was", async () => {
	stubApi([{ body: NOT_CONFIGURED }, { body: { error: "AWS rejected these credentials. Check the access key ID and secret." }, status: 400 }]);
	const save = await renderPanel();
	await save();

	assert.equal(document.querySelector("body details"), null);
	assert.match(document.querySelector("body [role=alert]").textContent, /AWS rejected these credentials/);
});

test("a successful save keeps the credentials row and drops the refusal block", async () => {
	const configured = { configured: true, source: "settings", region: "us-east-1", accessKeyHint: "…MPLE", accountId: "123456789012" };
	stubApi([
		{ body: NOT_CONFIGURED },
		{ body: REFUSAL, status: 400 },
		{ body: { status: configured, report: { ...REFUSAL.report, sending: true, productionAccess: true, missing: [] } } },
	]);
	const save = await renderPanel();
	await save();
	assert.ok(document.querySelector("body details"));
	await save();

	assert.equal(document.querySelector("body details"), null, "the refused report is cleared once the credentials save");
	assert.equal(document.querySelector("body [role=alert]"), null);
});

test("the admin API answers a refused save with the policy it tells the admin to attach", async () => {
	const route = readFileSync(join(root, "src/app/api/admin/aws/route.ts"), "utf8");
	const refusal = route.slice(route.indexOf("!report.sending && !report.receiving"));
	assert.match(refusal, /policy: AWS_IAM_POLICY/, "the 400 body carries the policy");
	assert.match(AWS_IAM_POLICY_SOURCE, /export const AWS_IAM_POLICY = \{/, "the policy the route sends is the one validate.ts defines");
});

test("requestJson keeps the parsed body on a rejected response", async () => {
	stubApi([{ body: { error: "nope", report: REFUSAL.report }, status: 400 }]);
	const error = await requestJson("/api/admin/aws", "PUT", {}).then(() => null, (err) => err);

	assert.ok(error instanceof ApiError);
	assert.equal(error.message, "nope");
	assert.deepEqual(error.data.report, REFUSAL.report);
	assert.equal(typeof en["aws.missingSummary"], "string");
});