import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const language = `export function useLanguage() { return { t: (key) => key }; }`;
const icons = `import React from "react"; export const ChevronUp = () => React.createElement("i"); export const Menu = () => React.createElement("i");`;
const mobile = `export function useIsMobile() { return true; }`;
const nav = `export function usePathname() { return "/a"; }`;

async function mount(t, element) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(element); });
	return container;
}
const escape = () => act(async () => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });

test("the section sheet is modal on mobile, takes focus on open and returns it to the trigger", async (t) => {
	const { SectionNavSheet } = await loadComponent("src/components/section-nav-sheet.tsx", {
		"@/components/icons": icons,
		"next/navigation": nav,
		"./sidebar-mobile-utils": mobile,
	});
	await mount(t, createElement(SectionNavSheet, { label: "Section", title: "Sections" }, createElement("a", { href: "/x" }, "First")));
	const trigger = document.querySelector("button[aria-haspopup]");
	const aside = document.querySelector("aside");
	assert.equal(aside.getAttribute("aria-modal"), "true");
	await act(async () => { trigger.focus(); trigger.click(); });
	assert.equal(document.activeElement, aside.querySelector("a"));
	await escape();
	assert.equal(document.activeElement, trigger);
});

test("the sidebar drawer takes focus on open and returns it to the menu button", async (t) => {
	let open = false;
	const state = { mobile: true, get mobileOpen() { return open; }, toggle() { open = !open; } };
	globalThis.__sidebar = state;
	const { SidebarAside } = await loadComponent("src/components/sidebar-aside.tsx", {
		"@/components/icons": icons,
		"next/link": `import React from "react"; export default function Link(p) { return React.createElement("a", p); }`,
		"./sidebar-state": `export function useSidebar() { return globalThis.__sidebar; }`,
		"./language-provider": language,
		"./branding-provider": `export function useBranding() { return { iconUrl: "/i.png" }; }`,
	});
	const menu = document.createElement("button");
	menu.setAttribute("data-mobile-menu", "");
	document.body.appendChild(menu);
	t.after(() => menu.remove());
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	const render = () => act(async () => { root.render(createElement(SidebarAside, null, createElement("a", { href: "/inbox" }, "Inbox"))); });
	await render();
	menu.focus();
	open = true;
	await render();
	assert.equal(document.activeElement, container.querySelector("aside a"));
	open = false;
	await render();
	assert.equal(document.activeElement, menu);
});
