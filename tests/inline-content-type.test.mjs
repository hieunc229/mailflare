import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["src/lib/http/content-type.ts"], bundle: true, write: false, platform: "neutral", format: "esm" });
const { getInlineContentType, getMimeEssence } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("inline types are served as their bare essence", () => {
	assert.equal(getInlineContentType("image/PNG"), "image/png");
	assert.equal(getInlineContentType("image/jpeg; name=\"photo.jpg\""), "image/jpeg");
	assert.equal(getInlineContentType("application/pdf"), "application/pdf");
	assert.equal(getInlineContentType("video/mp4"), "video/mp4");
	assert.equal(getInlineContentType("audio/mpeg"), "audio/mpeg");
	assert.equal(getInlineContentType("text/plain; charset=\"ISO-8859-1\"; format=flowed"), "text/plain; charset=ISO-8859-1");
	assert.equal(getInlineContentType("text/csv"), "text/csv");
});

test("active or unparsable types never render inline", () => {
	for (const type of [
		"text/html",
		"TEXT/HTML; charset=utf-8",
		"image/svg+xml",
		"image/svg+xml;charset=utf-8",
		"image/svg+xml ; charset=utf-8",
		"application/xml",
		"text/xml",
		"application/xhtml+xml",
		"application/javascript",
		"image/png, text/html",
		"image/png; x=1, text/html",
		"text/plain; charset=\"a,b\"",
		"image/png\ttext/html",
		"multipart/related",
		"",
		null,
		undefined,
	]) {
		assert.equal(getInlineContentType(type), null, String(type));
	}
});

test("downloads keep a clean essence or fall back to opaque bytes", () => {
	assert.equal(getMimeEssence("image/svg+xml;charset=utf-8"), "image/svg+xml");
	assert.equal(getMimeEssence(" Text/HTML "), "text/html");
	assert.equal(getMimeEssence("image/png, text/html"), null);
	assert.equal(getMimeEssence("not a type"), null);
});
