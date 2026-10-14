import assert from "node:assert/strict";
import test from "node:test";
import { getSheetViewportStyle } from "../src/components/compose/sheet-viewport-utils.ts";

test("sheet fills the visual viewport when no keyboard is open", () => {
	const style = getSheetViewportStyle(800, 780, 0);
	assert.equal(style.height, "780px");
	assert.equal(style.bottom, "20px");
	assert.equal(style.padding, "max(env(safe-area-inset-bottom), 1rem)");
});

test("sheet shrinks above the keyboard and drops safe-area padding", () => {
	const style = getSheetViewportStyle(800, 450, 0);
	assert.equal(style.height, "450px");
	assert.equal(style.bottom, "350px");
	assert.equal(style.padding, "0.5rem");
});
