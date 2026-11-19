import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-pwa-manifest-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function loadManifest() {
	const outfile = join(outDir, "manifest.mjs");
	await build({
		entryPoints: [join(root, "src/app/manifest.ts")],
		bundle: true,
		format: "esm",
		platform: "node",
		outfile,
		logLevel: "silent",
	});
	return (await import(outfile)).default();
}

test("manifest has a maskable icon entry that exists in public/", async () => {
	const manifest = await loadManifest();
	const maskable = manifest.icons.filter((icon) => icon.purpose === "maskable");
	assert.equal(maskable.length, 1);
	assert.equal(maskable[0].sizes, "512x512");
	assert.equal(maskable[0].type, "image/png");
	const bytes = readFileSync(join(root, "public", maskable[0].src));
	assert.equal(bytes.readUInt32BE(16), 512, "PNG width");
	assert.equal(bytes.readUInt32BE(20), 512, "PNG height");
});

test("manifest keeps the existing any-purpose icons", async () => {
	const manifest = await loadManifest();
	const anyIcons = manifest.icons.filter((icon) => !icon.purpose || icon.purpose === "any");
	assert.deepEqual(anyIcons.map((icon) => icon.src), ["/icon-192.png", "/icon-512.png"]);
});

test("manifest theme_color matches the light viewport theme colour", async () => {
	const manifest = await loadManifest();
	const layout = readFileSync(join(root, "src/app/layout.tsx"), "utf8");
	const light = layout.match(/prefers-color-scheme: light\)", color: "(#[0-9a-f]{6})"/i)?.[1];
	assert.ok(light);
	assert.equal(manifest.theme_color, light);
});

// Android masks the icon to a circle of 40% of the width; the artwork must sit inside the 80% safe zone (radius 205 of 512).
test("maskable icon artwork fits inside the safe-zone circle", async () => {
	const { default: sharp } = await import("sharp");
	const { data, info } = await sharp(join(root, "public/icon-maskable-512.png")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
	for (let y = 0; y < info.height; y++) {
		for (let x = 0; x < info.width; x++) {
			const i = (y * info.width + x) * 4;
			if (data[i + 3] > 16 && !(data[i] > 250 && data[i + 1] > 250 && data[i + 2] > 250)) {
				x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
			}
		}
	}
	const centre = info.width / 2;
	for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
		assert.ok(Math.hypot(x - centre, y - centre) <= 205, `corner ${x},${y} outside the safe zone`);
	}
	assert.ok(x1 - x0 > 250, "logo should still fill about 60% of the width");
});
