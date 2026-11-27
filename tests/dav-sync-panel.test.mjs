import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadFixture } from "./helpers/fixtures.mjs";

globalThis.davPanelH = createElement;
const fixture = await loadFixture({
	name: "dav-sync-panel",
	entryPoint: "src/components/settings/dav-sync-panel.tsx",
	mocks: {
		"next/link": "export default function Link({href,children,...p}){return globalThis.davPanelH('a',{href,...p},children)}",
		"@/components/language-provider": "export function useLanguage(){return {t:(key,vars)=>key+(vars?JSON.stringify(vars):'')}}",
		"@/components/icons": "export const Copy=()=>null;",
		"@/components/ui/button": "export function Button({children,...p}){return globalThis.davPanelH('button',p,children)}",
	},
});
const { DavSyncPanel } = await fixture.import();
after(() => { delete globalThis.davPanelH; fixture.dispose(); });

const base = { dav: { enabled: true, userId: "u1", email: "me@example.com", calendarEnabled: true, isAdmin: false }, origin: "https://mail.example.com", hasPassword: true, onCreate() {}, onCopy() {}, copied: null };
const html = (props) => renderToStaticMarkup(createElement(DavSyncPanel, { ...base, ...props }));

test("with sync off it explains who can turn it on and shows no addresses", () => {
	const user = html({ dav: { ...base.dav, enabled: false } });
	assert.match(user, /appPasswords\.dav\.off/);
	assert.ok(!user.includes("/dav/") && !user.includes("openAdmin"));
	const admin = html({ dav: { ...base.dav, enabled: false, isAdmin: true } });
	assert.match(admin, /<a href="\/general"[^>]*>appPasswords\.dav\.openAdmin/);
});

test("with sync on every address has its own labelled copy button", () => {
	const out = html({});
	for (const address of ["https://mail.example.com/dav/", "https://mail.example.com/dav/calendars/u1/default/", "https://mail.example.com/dav/addressbooks/u1/default/", "me@example.com"]) assert.ok(out.includes(`>${address}</code>`), address);
	const labels = [...out.matchAll(/aria-label="common\.copyLabel\{&quot;label&quot;:&quot;([^&]+)&quot;\}"/g)].map((match) => match[1]);
	assert.deepEqual(labels, ["appPasswords.dav.baseUrl", "emailClients.username", "appPasswords.dav.caldavUrl", "appPasswords.dav.carddavUrl"]);
	// Addresses stay left-to-right inside right-to-left pages, and layout uses logical classes.
	assert.equal(out.match(/dir="ltr"/g).length, 4);
	assert.ok(!/\b(ml|mr|pl|pr|text-left|text-right)-/.test(out) && !/\b(ml|mr)-\d/.test(out));
});

test("no app password yet offers to create one; a held one does not", () => {
	assert.match(html({ hasPassword: false }), /appPasswords\.dav\.noPassword[\s\S]*appPasswords\.dav\.createOne/);
	assert.ok(!html({}).includes("appPasswords.dav.noPassword"));
});

test("the three apps are collapsible sections and a disabled calendar is called out", () => {
	const out = html({ dav: { ...base.dav, calendarEnabled: false } });
	assert.equal(out.match(/<details/g).length, 3);
	assert.equal(out.match(/<summary/g).length, 3);
	assert.match(out, /appPasswords\.dav\.noCalendar/);
	assert.ok(!html({}).includes("noCalendar"));
});

test("a page with no known origin shows no addresses rather than broken ones", () => {
	const out = html({ origin: "" });
	assert.ok(!out.includes("/dav/"));
});

test("static text is not a live region; only the copy status announces", () => {
	assert.ok(!html({ dav: { ...base.dav, enabled: false } }).includes("role="));
	assert.ok(!html({ dav: { ...base.dav, calendarEnabled: false } }).includes("role="));
});

test("a plain-HTTP address warns about HTTPS, except on this machine", () => {
	for (const origin of ["http://mail.example.com", "http://192.168.1.5:3000"]) assert.match(html({ origin }), /appPasswords\.dav\.needsHttps/, origin);
	for (const origin of ["https://mail.example.com", "http://localhost:3000", "http://127.0.0.1:3000"]) assert.ok(!html({ origin }).includes("needsHttps"), origin);
});

test("the copied mark follows the field id, not the label, and copy buttons are 44 px tall on mobile", () => {
	assert.equal(html({ copied: "dav-username" }).match(/>common\.copied</g)?.length, 1);
	assert.ok(!html({}).includes("common.copied"));
	assert.equal(html({}).match(/min-h-11/g).length, 4);
});
