import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadComponent } from "./helpers/dom-component.mjs";

test("a failed upload error is announced", async () => {
	const mod = await loadComponent("src/app/(drive)/drive-upload-panel.tsx", {
		"@/components/language-provider": "export const useLanguage = () => ({ t: (key) => key });",
	});
	const html = renderToStaticMarkup(createElement(mod.DriveUploadPanel, { uploads: [{ id: "u1", name: "a.png", percent: 0, resumed: false, status: "failed", error: "boom" }], onClose() {} }));
	assert.match(html, /<p[^>]*role="alert"[^>]*>boom<\/p>/);
});
