import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadFixture } from "./helpers/fixtures.mjs";

const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
globalThis.orgFbUi = { en };
const mocks = {
	"@/components/language-provider": "export function useLanguage(){return {t:(key,values={})=>(globalThis.orgFbUi.en[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>values[n]??m)}}",
};
const fixture = await loadFixture({ name: "org-fb-ui", entryPoint: "src/app/(admin)/general/org-free-busy-view.tsx", mocks });
const { OrgFreeBusyView } = await fixture.import();
after(() => { delete globalThis.orgFbUi; fixture.dispose(); });

const render = (props) => renderToStaticMarkup(createElement(OrgFreeBusyView, { state: "ready", enabled: false, saving: false, status: "", onChange: () => {}, onRetry: () => {}, ...props }));

test("the switch is labelled, reflects the setting and explains what it shares", () => {
	const off = render({ enabled: false });
	assert.match(off, /role="switch"/);
	assert.match(off, /aria-checked="false"/);
	assert.match(off, /<label[^>]*for="org-free-busy"[^>]*>Let everyone see when everyone else is busy<\/label>/);
	assert.match(off, /never titles or details/);
	assert.match(render({ enabled: true }), /aria-checked="true"/);
});

test("loading is announced, a failure is an alert with a retry, and a saved change is announced politely", () => {
	assert.match(render({ state: "loading" }), /role="status".*Loading\.\.\./);
	const failed = render({ state: "error" });
	assert.match(failed, /role="alert"/);
	assert.match(failed, /Try again/);
	assert.match(render({ status: "Saved" }), /role="status"[^>]*>Saved</);
});

test("while saving the switch is disabled", () => {
	assert.match(render({ saving: true }), /<button[^>]*role="switch"[^>]*disabled/);
});

test("without a Team licence nothing is shown", () => {
	assert.equal(render({ state: "unavailable" }), "");
});

test("a switch left on after the licence lapsed stays visible, says it is not in effect, and can be turned off", () => {
	const html = render({ enabled: true, available: false });
	assert.match(html, /role="switch"/);
	assert.match(html, /aria-checked="true"/);
	assert.match(html, /not in effect/);
	assert.doesNotMatch(render({ enabled: true }), /not in effect/);
});
