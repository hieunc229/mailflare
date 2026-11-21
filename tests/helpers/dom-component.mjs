import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../../", import.meta.url));
let installed = false;

/** Installs a JSDOM window as the global DOM (once per test process). */
export function installDom() {
	if (installed) return;
	installed = true;
	const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
	for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event", "KeyboardEvent", "HTMLInputElement", "File", "FormData"]) {
		globalThis[key] = key === "window" ? dom.window : dom.window[key];
	}
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

/**
 * Bundles one source file with esbuild and imports it. `stubs` maps an import
 * specifier to replacement module source; imports that resolve inside
 * `stubbed(path)` handlers can also be redirected by passing a function.
 */
export async function loadComponent(sourceFile, stubs = {}) {
	installDom();
	const temp = mkdtempSync(join(root, "node_modules", "mailflare-dom-component-"));
	after(() => rmSync(temp, { recursive: true, force: true }));
	const outfile = join(temp, "out.mjs");
	await build({
		entryPoints: [join(root, sourceFile)],
		outfile,
		bundle: true,
		platform: "browser",
		format: "esm",
		jsx: "automatic",
		packages: "external",
		external: ["react", "react-dom", "react-dom/*", "lucide-react"],
		alias: { "@": join(root, "src") },
		plugins: [{
			name: "dom-component-stubs",
			setup(b) {
				b.onResolve({ filter: /.*/ }, (args) => {
					const key = Object.keys(stubs).find((specifier) => specifier === args.path);
					if (key) return { path: key, namespace: "dom-stub" };
					return undefined;
				});
				b.onLoad({ filter: /.*/, namespace: "dom-stub" }, (args) => ({ contents: stubs[args.path], loader: "tsx" }));
			},
		}],
		logLevel: "silent",
	});
	return import(pathToFileURL(outfile).href);
}
