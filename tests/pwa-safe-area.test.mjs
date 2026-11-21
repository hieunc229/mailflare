import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function layouts(dir) {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return layouts(path);
		return name === "layout.tsx" ? [path] : [];
	});
}

// A layout that draws a full-viewport shell (h-dvh / 100dvh) is a standalone screen in an installed app,
// so its root must take the safe-area padding from the shared `safe-area` utility in globals.css.
test("every full-viewport app shell uses the safe-area utility", () => {
	const shells = layouts(join(root, "src/app")).filter((file) => /[" ]h-dvh[" ]|[" ]h-\[100dvh\][" ]/.test(readFileSync(file, "utf8")));
	assert.ok(shells.length >= 5, "expected the dashboard, admin, calendar, drive and settings shells");
	for (const file of shells) {
		assert.match(readFileSync(file, "utf8"), /className="safe-area /, relative(root, file));
	}
});

test("the safe-area utility pads all four sides from env(safe-area-inset-*)", () => {
	const css = readFileSync(join(root, "src/app/globals.css"), "utf8");
	const block = css.match(/@utility safe-area \{([^}]*)\}/)?.[1] ?? "";
	for (const side of ["top", "right", "bottom", "left"]) {
		assert.match(block, new RegExp(`padding-${side}: env\\(safe-area-inset-${side}\\);`));
	}
});

// Pages and shells without one of those layouts still reach the notch once viewportFit is "cover".
// Each must use the `safe-area` utility or its own env(safe-area-inset-*) padding on the root element.
test("layout-less pages, auth shell, skeletons and the mobile drawer clear the safe areas", () => {
	const files = [
		["src/app/page.tsx", /safe-area min-h-dvh/, /safe-area min-h-dvh/],
		["src/app/d/[token]/page.tsx", /safe-area-inset-top/, /safe-area-inset-bottom/],
		["src/app/book/[userId]/page.tsx", /safe-area-inset-top/, /safe-area-inset-bottom/],
		["src/app/book/[userId]/[eventId]/page.tsx", /safe-area-inset-top/, /safe-area-inset-bottom/],
		["src/components/auth/auth-shell.tsx", /pt-\[env\(safe-area-inset-top\)\]/, /pl-\[env\(safe-area-inset-left\)\]/],
		["src/components/route-skeleton.tsx", /safe-area flex h-dvh/, /safe-area flex h-dvh/],
		["src/components/sidebar-aside.tsx", /pb-\[env\(safe-area-inset-bottom\)\]/, /md:pb-0/],
	];
	for (const [file, a, b] of files) {
		const text = readFileSync(join(root, file), "utf8");
		assert.match(text, a, file);
		assert.match(text, b, file);
	}
	const skeleton = readFileSync(join(root, "src/components/route-skeleton.tsx"), "utf8");
	assert.equal(skeleton.match(/h-dvh flex-col/g)?.length, skeleton.match(/safe-area flex h-dvh flex-col/g)?.length);
});

test("the shells already padded by a layout are not padded twice", () => {
	const text = readFileSync(join(root, "src/components/loading-transition.tsx"), "utf8");
	assert.doesNotMatch(text, /safe-area/);
});
