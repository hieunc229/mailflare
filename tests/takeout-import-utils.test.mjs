import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

test("takeout progress helpers do not throw when localStorage is blocked", async () => {
	const utils = await loadComponent("src/components/settings/takeout-import-utils.ts", {});
	const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
	try {
		const source = { key: "k", label: "l", size: 1, open: async () => null };
		assert.equal(utils.getTakeoutProgress("m1", source), 0);
		assert.doesNotThrow(() => utils.saveTakeoutProgress("m1", source, 5));
		assert.doesNotThrow(() => utils.clearTakeoutProgress("m1", source));
	} finally {
		if (original) Object.defineProperty(globalThis, "localStorage", original);
		else delete globalThis.localStorage;
	}
});
