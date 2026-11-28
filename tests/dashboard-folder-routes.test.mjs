import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const root = join(import.meta.dirname, "..");
const routeDir = join(root, "src/app/(dashboard)");
const read = (path) => readFileSync(join(routeDir, path), "utf8");
const slugs = ["archived", "promotions", "sent", "spam", "starred", "trash", "snoozed", "scheduled"];

test("each folder slug has its own config", async () => {
	const configs = await loadComponent("src/components/messages/message-folder-configs.ts");
	for (const slug of slugs) {
		assert.equal(configs[`${slug}FolderConfig`].folder, slug);
		assert.equal(configs[`${slug}FolderConfig`].hrefPrefix, `/${slug}`);
	}
});

test("the [folder] route serves exactly the folder slugs", async () => {
	const mod = await loadComponent("src/app/(dashboard)/[folder]/folder-slugs.ts");
	assert.deepEqual([...mod.folderSlugs].sort(), [...slugs].sort());
	const shell = read("[folder]/folder-shell.tsx");
	for (const slug of slugs) assert.match(shell, new RegExp(`\\b${slug}:\\s*${slug}FolderConfig\\b`));
	assert.ok(shell.includes("key={folder}"));
});

test("the layout pre-renders exactly the folder slugs and refuses any other", async () => {
	const layout = await loadComponent("src/app/(dashboard)/[folder]/layout.tsx", {
		"./folder-shell": "export function FolderShell() { return null; }",
		"next/navigation": "export function notFound() { throw new Error('NEXT_NOT_FOUND'); }",
	});
	const mod = await loadComponent("src/app/(dashboard)/[folder]/folder-slugs.ts");
	assert.deepEqual(layout.generateStaticParams(), mod.folderSlugs.map((folder) => ({ folder })));
	assert.equal(layout.dynamicParams, false);
});

test("the layout answers 404 for an unknown slug even where dynamicParams is not enforced", async () => {
	const layout = await loadComponent("src/app/(dashboard)/[folder]/layout.tsx", {
		"./folder-shell": "export function FolderShell() { return null; }",
		"next/navigation": 'export function notFound() { throw new Error("NEXT_NOT_FOUND"); }',
	});
	for (const folder of ["foo", "constructor", "sent2"]) {
		await assert.rejects(layout.default({ children: null, params: Promise.resolve({ folder }) }), /NEXT_NOT_FOUND/, folder);
	}
	assert.ok(await layout.default({ children: null, params: Promise.resolve({ folder: "sent" }) }));
});

test("[folder] page and message page are the thin copies", () => {
	assert.ok(read("[folder]/page.tsx").includes("return null"));
	assert.ok(read("[folder]/[messageId]/page.tsx").includes("@/app/(dashboard)/inbox/[messageId]/page"));
});

test("legacy per-folder route directories are gone", () => {
	for (const slug of slugs) assert.equal(existsSync(join(routeDir, slug)), false, slug);
});
