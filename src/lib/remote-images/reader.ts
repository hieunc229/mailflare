import * as css from "css-tree";
import parseSrcset from "parse-srcset";
import { prepareEmailHtml } from "@/lib/email/html";

export function remoteImageUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return value;
		return `/api/remote-images?url=${encodeURIComponent(url.href)}`;
	} catch {
		return value;
	}
}

const IMAGE_FUNCTIONS = new Set(["image", "image-set", "-webkit-image-set", "src"]);
const IMAGE_PROPERTIES = new Set([
	"background", "background-image", "border-image", "border-image-source",
	"list-style", "list-style-image", "mask", "mask-image", "-webkit-mask",
	"-webkit-mask-image", "cursor", "shape-outside",
]);

/** Collect custom-property references, including nested var() fallbacks. */
function variableReferences(node: css.CssNode, references: Set<string>) {
	css.walk(node, child => {
		if (child.type !== "Function" || css.ident.decode(child.name).toLowerCase() !== "var") return;
		const name = child.children.first;
		if (name?.type === "Identifier") references.add(css.ident.decode(name.name));
	});
}

function renameVariables(node: css.CssNode, proxyNames: Map<string, string>) {
	css.walk(node, child => {
		if (child.type !== "Function" || css.ident.decode(child.name).toLowerCase() !== "var") return;
		const name = child.children.first;
		if (name?.type !== "Identifier") return;
		const proxyName = proxyNames.get(css.ident.decode(name.name));
		if (proxyName) name.name = css.ident.encode(proxyName);
	});
}

function proxyStrings(node: css.CssNode) {
	css.walk(node, child => {
		if (child.type === "String") child.value = remoteImageUrl(child.value);
	});
}

/** Give image uses their own variable chain so text and font uses keep the original value. */
function proxyCss(ast: css.CssNode, proxyNames: Map<string, string>): string {
	css.walk(ast, {
		enter(node, item, list) {
			if (node.type === "Declaration" && css.ident.decode(node.property).toLowerCase() === "src") return css.walk.skip;
			if (node.type !== "Declaration") return;
			const property = css.ident.decode(node.property);
			if (property.startsWith("--")) {
				const proxyName = proxyNames.get(property);
				if (proxyName && item && list) {
					const copy = css.clone(node) as typeof node;
					copy.property = css.ident.encode(proxyName);
					renameVariables(copy.value, proxyNames);
					proxyStrings(copy.value);
					list.insertData(copy, item.next);
				}
				// Preserve direct image-function strings in the original declaration.
				css.walk(node.value, child => {
					if (child.type === "Function" && IMAGE_FUNCTIONS.has(css.ident.decode(child.name).toLowerCase())) proxyStrings(child);
				});
			} else {
				if (IMAGE_PROPERTIES.has(property.toLowerCase())) renameVariables(node.value, proxyNames);
				css.walk(node.value, child => {
					if (child.type === "Function" && IMAGE_FUNCTIONS.has(css.ident.decode(child.name).toLowerCase())) {
						renameVariables(child, proxyNames);
						proxyStrings(child);
					}
				});
			}
			return css.walk.skip;
		},
	});
	css.walk(ast, node => {
		if (node.type === "Declaration" && css.ident.decode(node.property).toLowerCase() === "src") return css.walk.skip;
		if (node.type === "Url") node.value = remoteImageUrl(node.value);
	});
	return css.generate(ast);
}

export function prepareReaderEmailHtml(source: string, options: { reader: true; allowRemote: boolean; proxyRemote?: boolean }) {
	const prepared = prepareEmailHtml(source, options);
	if (!options.allowRemote || !prepared.hasRemote || options.proxyRemote === false) return prepared;

	// Only transform the upstream sanitizer's inert output, never raw email HTML.
	const template = document.createElement("template");
	template.innerHTML = prepared.html;
	const cssEntries: Array<{ element: Element; inline: boolean; ast: css.CssNode }> = [];
	const definitions = new Map<string, css.CssNode[]>();
	const imageVariables = new Set<string>();
	for (const element of template.content.querySelectorAll("*")) {
		for (const [value, inline] of [[element.getAttribute("style"), true], [element.tagName === "STYLE" ? element.textContent : null, false]] as const) {
			if (!value) continue;
			try {
				const ast = css.parse(value, { context: inline ? "declarationList" : "stylesheet", parseCustomProperty: true });
				css.walk(ast, node => {
					if (node.type !== "Declaration") return;
					const property = css.ident.decode(node.property);
					if (property.startsWith("--")) {
						const values = definitions.get(property) ?? [];
						values.push(node.value);
						definitions.set(property, values);
					} else if (property.toLowerCase() !== "src") {
						if (IMAGE_PROPERTIES.has(property.toLowerCase())) variableReferences(node.value, imageVariables);
						css.walk(node.value, child => {
							if (child.type === "Function" && IMAGE_FUNCTIONS.has(css.ident.decode(child.name).toLowerCase())) {
								variableReferences(child, imageVariables);
							}
						});
					}
					return css.walk.skip;
				});
				cssEntries.push({ element, inline, ast });
			} catch {
				// Preserve CSS the parser cannot handle.
			}
		}
	}
	for (const name of imageVariables) {
		for (const value of definitions.get(name) ?? []) variableReferences(value, imageVariables);
	}
	const proxyNames = new Map([...imageVariables].map((name, index) => [name, "--mailflare-image-" + prepared.rootTag + "-" + index]));
	for (const { element, inline, ast } of cssEntries) {
		try {
			if (inline) element.setAttribute("style", proxyCss(ast, proxyNames));
			else element.textContent = proxyCss(ast, proxyNames);
		} catch {
			// Keep the sanitizer's CSS if proxy generation fails.
		}
	}
	for (const element of template.content.querySelectorAll("*")) {
		for (const attribute of ["src", "background", "poster"]) {
			const value = element.getAttribute(attribute);
			if (value) element.setAttribute(attribute, remoteImageUrl(value));
		}
		const srcset = element.getAttribute("srcset");
		if (srcset) {
			element.setAttribute("srcset", parseSrcset(srcset).map(candidate =>
				`${remoteImageUrl(candidate.url)}${candidate.w ? ` ${candidate.w}w` : candidate.d !== undefined ? ` ${candidate.d}x` : ""}`,
			).join(", "));
		}
	}
	return { ...prepared, html: template.innerHTML };
}
