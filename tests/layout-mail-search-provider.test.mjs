import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const components = join(root, "src/components");
const app = join(root, "src/app");

// NavItem calls useMailSearch(), which throws outside MailSearchProvider. Every
// sidebar built from NavItem therefore needs the provider above it in its layout.
const navComponents = readdirSync(components)
	.filter((file) => file.endsWith(".tsx"))
	.map((file) => readFileSync(join(components, file), "utf8"))
	.filter((source) => /import\s*\{[^}]*\bNavItem\b[^}]*\}\s*from\s*"\.\/components-nav"/.test(source))
	.flatMap((source) => [...source.matchAll(/export function (\w+)/g)].map((match) => match[1]));

const layouts = readdirSync(app, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && /^\(.+\)$/.test(entry.name))
	.map((entry) => join(app, entry.name, "layout.tsx"))
	.flatMap((path) => {
		try {
			return [{ path, source: readFileSync(path, "utf8") }];
		} catch {
			return [];
		}
	});

test("NavItem-based sidebars are found", () => {
	assert.ok(navComponents.includes("AdminNav"), `AdminNav not detected in ${navComponents.join(", ")}`);
	assert.ok(navComponents.includes("DashboardNav"), `DashboardNav not detected in ${navComponents.join(", ")}`);
});

test("every route group layout that renders a NavItem sidebar mounts MailSearchProvider around it", () => {
	let checked = 0;
	for (const { path, source } of layouts) {
		for (const nav of navComponents) {
			const navAt = source.indexOf(`<${nav}`);
			if (navAt === -1) continue;
			checked++;
			const name = path.slice(root.length);
			const openAt = source.indexOf("<MailSearchProvider>");
			const closeAt = source.indexOf("</MailSearchProvider>");
			assert.ok(openAt !== -1 && closeAt !== -1, `${name} renders <${nav}> without MailSearchProvider`);
			assert.ok(openAt < navAt && navAt < closeAt, `${name} renders <${nav}> outside MailSearchProvider`);
		}
	}
	assert.ok(checked >= 3, `expected the admin, dashboard and settings layouts, checked ${checked}`);
});
