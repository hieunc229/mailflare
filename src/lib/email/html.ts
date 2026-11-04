import createDOMPurify from "dompurify";
import * as css from "css-tree";
import { parse, serialize, type DefaultTreeAdapterTypes } from "parse5";
import parseSrcset from "parse-srcset";
import type { SanitizeEmailHtmlOptions } from "@/app/(dashboard)/inbox/[messageId]/email-html-sanitizer-types";

type Options = SanitizeEmailHtmlOptions & {
	allowRemote?: boolean;
	reader?: boolean;
	editor?: boolean;
};

type MailDocument = { template: HTMLTemplateElement; rootTag: string; bodyTag: string; needsWrapper: boolean };
const nameOf = (name: string) => css.ident.decode(name).toLowerCase();
const BLOCKED_IMAGE = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const RESOURCE_ATTRIBUTES = ["src", "background", "poster"];
const EDITOR_ATTRIBUTES = ["data-mailflare-src", "data-mailflare-background", "data-mailflare-poster", "data-mailflare-srcset", "data-mailflare-style", "data-mailflare-sheet"];

function outgoingScope(source: string): string {
	// Stable presentation names keep repeated signature generation comparable. These are
	// not a security boundary; reader containers always use fresh, unpredictable names.
	let hash = 2166136261;
	for (let index = 0; index < source.length; index++) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
	return `outgoing${(hash >>> 0).toString(16)}`;
}

/** Parse without a browser DOM, then populate an inert template. No network is possible. */
function mailDocument(source: string, outgoing = false): MailDocument {
	// A document starting with <frameset> has no body; frames cannot be shown, so drop them.
	let parsed = parse(source);
	if (!parsed.childNodes.some((node) => "tagName" in node && node.tagName === "html") || /<frameset\b/i.test(source)) {
		parsed = parse(source.replace(/<\/?frame(?:set)?\b[^>]*>/gi, ""));
	}
	const html = parsed.childNodes.find((node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "html")!;
	const head = html.childNodes.find((node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "head")!;
	const body = html.childNodes.find((node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "body")!;
	// Fresh element names avoid collisions with mail classes/IDs and never define custom elements.
	const token = outgoing ? outgoingScope(source) : window.crypto.randomUUID().replaceAll("-", "");
	const rootTag = `mail-root-${token}`;
	const bodyTag = `mail-body-${token}`;
	html.tagName = html.nodeName = rootTag;
	body.tagName = body.nodeName = bodyTag;
	const headContent = head.childNodes.filter(node => "tagName" in node && ["style", "base"].includes(node.tagName));
	html.childNodes = [...headContent, body];
	for (const child of html.childNodes) child.parentNode = html;
	const template = document.createElement("template");
	template.innerHTML = serialize(parsed);
	return { template, rootTag, bodyTag, needsWrapper: !!html.attrs.length || !!body.attrs.length || headContent.some(node => "tagName" in node && node.tagName === "style") };
}

const SAFE_AT_RULES = new Set([
	"media", "supports", "font-face", "keyframes", "-webkit-keyframes", "layer",
	"container", "scope", "starting-style", "page", "property", "counter-style",
]);

/** Only remove unsupported syntax at its declaration/rule boundary, not an entire sheet. */
function transformCss(source: string, inline: boolean, resource: (value: string) => string | null, doc?: MailDocument, classScope = false, allowIndirect = false, onIndirect?: () => void): string {
	try {
		const ast = css.parse(source, {
			context: inline ? "declarationList" : "stylesheet",
			parseCustomProperty: true,
		});
		css.walk(ast, {
			enter(node, item, list) {
				const remove = () => { if (item && list) list.remove(item); };
				if (node.type === "Declaration") {
					if (["behavior", "-moz-binding"].includes(nameOf(node.property)) || css.find(node.value, child => child.type === "Raw")) {
						remove(); return css.walk.skip;
					}
				}
				if (node.type === "Rule" && css.find(node.prelude, child => child.type === "Raw")) {
					remove(); return css.walk.skip;
				}
				if (node.type === "Atrule") {
					const name = nameOf(node.name);
					if (!SAFE_AT_RULES.has(name) || (node.prelude && css.find(node.prelude, child => child.type === "Raw"))) {
						remove(); return css.walk.skip;
					}
					node.name = name;
				}
				if (node.type === "Raw") { remove(); return css.walk.skip; }
				if (node.type === "Selector" && css.find(node, child =>
					(child.type === "PseudoClassSelector" && ["host", "host-context"].includes(nameOf(child.name))) ||
					(child.type === "PseudoElementSelector" && ["slotted", "part"].includes(nameOf(child.name)))
				)) { remove(); return css.walk.skip; }
				if (node.type === "Function") {
					const name = nameOf(node.name);
					node.name = css.ident.encode(name);
					if (name === "expression") { remove(); return css.walk.skip; }
					if (["image", "image-set", "-webkit-image-set", "src"].includes(name)) {
						if (css.find(node, child => child.type === "Function" && ["var", "attr"].includes(nameOf(child.name)))) {
							onIndirect?.();
							if (!allowIndirect) {
								Object.assign(node, { type: "Url", value: BLOCKED_IMAGE });
								return css.walk.skip;
							}
						}
						node.children.forEach(child => {
							if (child.type === "String") child.value = resource(child.value) ?? BLOCKED_IMAGE;
						});
					}
					// Escaped url("...") can be represented as a generic Function by the parser.
					if (name === "url") {
						const first = node.children.first;
						const value = first?.type === "String" ? first.value : css.ident.decode(css.generate(node.children));
						Object.assign(node, { type: "Url", value: resource(value) ?? BLOCKED_IMAGE });
						return css.walk.skip;
					}
				}
				if (node.type === "Url") node.value = resource(node.value) ?? BLOCKED_IMAGE;
				if (doc && node.type === "TypeSelector") {
					const name = nameOf(node.name);
					if (name === "html" || name === "body") {
						if (classScope) doc.needsWrapper = true;
						Object.assign(node, {
						type: classScope ? "ClassSelector" : "TypeSelector", name: name === "html" ? doc.rootTag : doc.bodyTag,
					});
					}
				}
				if (doc && node.type === "PseudoClassSelector" && nameOf(node.name) === "root") {
					if (classScope) doc.needsWrapper = true;
					Object.assign(node, { type: classScope ? "ClassSelector" : "TypeSelector", name: doc.rootTag });
				}
			},
			leave(node, item, list) {
				if (node.type === "Rule" && node.prelude.type === "SelectorList" && node.prelude.children.isEmpty && item && list) list.remove(item);
			},
		});
		return css.generate(ast);
	} catch { return ""; }
}

function mapSrcset(source: string, resource: (value: string) => string | null): string {
	return parseSrcset(source).flatMap(candidate => {
		const url = resource(candidate.url);
		return url ? [`${url}${candidate.w ? ` ${candidate.w}w` : candidate.d !== undefined ? ` ${candidate.d}x` : ""}`] : [];
	}).join(", ");
}

function restoreEditorStyle(current: string, stored: string): string {
	try {
		const original = css.parse(decodeURIComponent(stored), { context: "declarationList", parseCustomProperty: true });
		const ast = css.parse(current, { context: "declarationList", parseCustomProperty: true });
		const originals = new Map<string, css.Declaration["value"]>();
		css.walk(original, node => { if (node.type === "Declaration") originals.set(node.property, node.value); });
		css.walk(ast, node => {
			if (node.type === "Declaration" && css.find(node.value, child => child.type === "Url" && child.value === BLOCKED_IMAGE)) {
				const value = originals.get(node.property);
				if (value) node.value = value;
			}
		});
		return css.generate(ast);
	} catch { return current; }
}

function legacyBodyStyles(element: HTMLDivElement) {
	const color = element.getAttribute("text");
	const background = element.getAttribute("bgcolor");
	const image = element.getAttribute("background");
	if (color && !element.style.color) element.style.color = color;
	if (background && !element.style.backgroundColor) element.style.backgroundColor = background;
	if (image && !element.style.backgroundImage) element.style.backgroundImage = `url(${JSON.stringify(image)})`;
	for (const [attribute, property] of [["topmargin", "margin-top"], ["bottommargin", "margin-bottom"], ["leftmargin", "margin-left"], ["rightmargin", "margin-right"]]) {
		const value = element.getAttribute(attribute);
		if (value && /^\d+$/.test(value) && !element.style.getPropertyValue(property)) element.style.setProperty(property, `${value}px`);
	}
}

export function resolveEmailCidUrls(source: string, urls: Map<string, string>): string {
	if (typeof document === "undefined" || !urls.size) return source;
	const doc = mailDocument(source);
	const resolve = (value: string) => {
		if (!/^cid:/i.test(value)) return value;
		const id = value.slice(4).replace(/^<|>$/g, "");
		try { return urls.get(id) ?? urls.get(decodeURIComponent(id)) ?? value; }
		catch { return urls.get(id) ?? value; }
	};
	for (const element of doc.template.content.querySelectorAll("*")) {
		for (const attr of RESOURCE_ATTRIBUTES) {
			if (element.hasAttribute(attr)) element.setAttribute(attr, resolve(element.getAttribute(attr)!));
		}
		if (element.hasAttribute("srcset")) element.setAttribute("srcset", mapSrcset(element.getAttribute("srcset")!, resolve));
		if (element.hasAttribute("style")) element.setAttribute("style", transformCss(element.getAttribute("style")!, true, resolve, undefined, false, true));
		if (element.tagName === "STYLE") element.textContent = transformCss(element.textContent ?? "", false, resolve, undefined, false, true);
	}
	// Return a document, not reader-specific containers. Its next consumer may be the sender.
	return restoreDocument(doc.template, doc, true);
}

function restoreDocument(template: HTMLTemplateElement, doc: MailDocument, full: boolean): string {
	const root = template.content.querySelector(doc.rootTag)!;
	const body = root.querySelector(doc.bodyTag)!;
	const headNodes = Array.from(root.querySelectorAll("style, base"));
	if (!full) return body.innerHTML;
	const html = document.createElement("html");
	const head = document.createElement("head");
	const bodyElement = document.createElement("body");
	for (const attribute of root.attributes) html.setAttribute(attribute.name, attribute.value);
	for (const attribute of body.attributes) bodyElement.setAttribute(attribute.name, attribute.value);
	for (const node of headNodes) head.appendChild(node);
	for (const child of Array.from(body.childNodes)) bodyElement.appendChild(child);
	html.appendChild(head);
	html.appendChild(bodyElement);
	return html.outerHTML;
}

/** Ordinary divs are portable in signatures and quoted fragments; no nested html/body tags. */
function outgoingFragment(template: HTMLTemplateElement, doc: MailDocument): string {
	const root = template.content.querySelector(doc.rootTag)!;
	const body = root.querySelector(doc.bodyTag)!;
	if (!doc.needsWrapper) return body.innerHTML;
	const convert = (element: Element, className: string) => {
		const replacement = document.createElement("div");
		for (const attribute of element.attributes) replacement.setAttribute(attribute.name, attribute.value);
		replacement.classList.add(className);
		for (const child of Array.from(element.childNodes)) replacement.appendChild(child);
		element.replaceWith(replacement);
	};
	convert(body, doc.bodyTag);
	convert(root, doc.rootTag);
	return template.innerHTML;
}

export function prepareEmailHtml(source: string, options: Options = {}) {
	const outgoing = !!options.forOutgoing && !options.editor;
	const doc = mailDocument(source, outgoing);
	const { template, rootTag, bodyTag } = doc;
	let hasRemote = false;
	const allowIndirect = !!options.allowRemote || outgoing;
	const markIndirect = () => { hasRemote = true; };
	const base = template.content.querySelector("base[href]")?.getAttribute("href");
	const resource = (value: string): string | null => {
		if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value)) return value;
		if (!options.forOutgoing && /^\/api\/messages\/[^/]+\/attachments\/[^/?]+\?preview=1$/.test(value)) return value;
		if (value.startsWith("#")) return value;
		try {
			const url = new URL(value, base || "https://invalid.invalid/");
			if (!["http:", "https:"].includes(url.protocol) || url.hostname === "invalid.invalid") return null;
			hasRemote = true;
			return options.allowRemote || (options.forOutgoing && !options.editor) ? url.href : null;
		} catch { return null; }
	};
	const root = template.content.querySelector<HTMLDivElement>(rootTag)!;
	const body = template.content.querySelector<HTMLDivElement>(bodyTag)!;
	for (const placeholder of template.content.querySelectorAll("[data-mailflare-sheet]")) {
		try {
			const style = document.createElement("style");
			style.textContent = decodeURIComponent(placeholder.getAttribute("data-mailflare-sheet")!);
			placeholder.replaceWith(style);
		} catch { placeholder.remove(); }
	}
	legacyBodyStyles(body);
	const linkColor = body.getAttribute("link");
	if (linkColor && /^#[a-f\d]{3,8}$/i.test(linkColor)) {
		const style = document.createElement("style");
		style.textContent = `body a:link{color:${linkColor}}`;
		root.insertBefore(style, root.firstChild);
	}
	const editorHeadStyles = document.createDocumentFragment();
	for (const element of template.content.querySelectorAll("*")) {
		if (element.tagName === "STYLE") {
			if (options.editor) {
				// Keep a non-executable copy for sending; never install mail CSS into the editor document.
				const placeholder = document.createElement("span");
				placeholder.hidden = true;
				placeholder.setAttribute("data-mailflare-sheet", encodeURIComponent(transformCss(element.textContent ?? "", false, value => value, undefined, false, true)));
				if (element.parentElement === root) {
					editorHeadStyles.appendChild(placeholder);
					element.remove();
				} else element.replaceWith(placeholder);
				continue;
			}
			if (!options.reader && !options.forOutgoing) { element.remove(); continue; }
			element.textContent = transformCss(element.textContent ?? "", false, resource, options.reader || outgoing ? doc : undefined, outgoing, allowIndirect, markIndirect);
		}
		// Editor placeholders preserve source addresses without loading them. Validate again on send.
		for (const attr of [...RESOURCE_ATTRIBUTES, "srcset", "style"]) {
			const stored = element.getAttribute(`data-mailflare-${attr}`);
			if (stored !== null) element.setAttribute(attr, attr === "style" ? restoreEditorStyle(element.getAttribute("style") ?? "", stored) : stored);
			element.removeAttribute(`data-mailflare-${attr}`);
		}
		if (element.hasAttribute("style")) {
			const original = element.getAttribute("style")!;
			const safe = transformCss(original, true, resource, options.reader ? doc : undefined, false, allowIndirect, markIndirect);
			if (options.editor && original !== safe) element.setAttribute("data-mailflare-style", encodeURIComponent(transformCss(original, true, value => {
				try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : resource(value); }
				catch { return resource(value); }
			}, undefined, false, true)));
			element.setAttribute("style", safe);
		}
		for (const attr of RESOURCE_ATTRIBUTES) {
			if (!element.hasAttribute(attr)) continue;
			const original = element.getAttribute(attr)!;
			const value = resource(original);
			if (value) element.setAttribute(attr, value);
			else {
				if (options.editor) element.setAttribute(`data-mailflare-${attr}`, original);
				element.removeAttribute(attr);
			}
		}
		if (element.hasAttribute("srcset")) {
			const original = element.getAttribute("srcset")!;
			const value = mapSrcset(original, resource);
			if (options.editor) element.setAttribute("data-mailflare-srcset", original);
			if (value) element.setAttribute("srcset", value); else element.removeAttribute("srcset");
		}
		if (element.tagName === "A" || element.tagName === "AREA") {
			const original = element.getAttribute("href") ?? "";
			if (original.startsWith("#")) {
				element.removeAttribute("target");
				element.removeAttribute("rel");
			} else {
				try {
					const href = new URL(original, base || "https://invalid.invalid/");
					if (!["https:", "http:", "mailto:", "tel:"].includes(href.protocol) || href.hostname === "invalid.invalid") element.removeAttribute("href");
					else element.setAttribute("href", href.href);
				} catch { element.removeAttribute("href"); }
				element.setAttribute("target", "_blank");
				element.setAttribute("rel", "noopener noreferrer");
			}
		}
		if (element.tagName === "AREA") element.setAttribute("referrerpolicy", "no-referrer");
		if (element.tagName === "IMG") {
			element.setAttribute("referrerpolicy", "no-referrer");
			element.setAttribute("loading", "lazy");
		}
	}
	if (options.editor) body.insertBefore(editorHeadStyles, body.firstChild);
	const purifier = createDOMPurify(window);
	const cleaned = purifier.sanitize(template.content, {
		USE_PROFILES: { html: true },
		ADD_TAGS: ["style", rootTag, bodyTag],
		ADD_ATTR: ["target", "loading", "referrerpolicy", ...(options.forOutgoing || options.editor ? ["data-mailflare-quote", "data-mailflare-signature"] : []), ...(options.editor ? EDITOR_ATTRIBUTES : [])],
		FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "select", "textarea", "link", "base", "meta", "audio", "video", "source", "template"],
		FORBID_ATTR: ["is", "slot", "popover", "popovertarget", "popovertargetaction", "command", "commandfor", "interestfor"],
		ALLOW_DATA_ATTR: false,
		RETURN_DOM_FRAGMENT: true,
	});
	const result = document.createElement("template");
	result.content.append(cleaned);
	// Stable serialization keeps the editor from replacing its DOM just for attribute order.
	for (const element of result.content.querySelectorAll("*")) {
		const attributes = Array.from(element.attributes).sort((a, b) => a.name.localeCompare(b.name));
		for (const attribute of attributes) element.removeAttribute(attribute.name);
		for (const attribute of attributes) element.setAttribute(attribute.name, attribute.value);
	}
	// Metadata on a converted body element needs explicit preservation; DOMPurify may drop
	// obsolete body-only attributes, whose visual equivalents were translated above.
	const output = options.reader ? result.innerHTML : outgoing ? outgoingFragment(result, doc) : restoreDocument(result, doc, false);
	return { html: output, hasRemote, rootTag, bodyTag };
}

export function sanitizeEmailHtml(html: string | null, options: SanitizeEmailHtmlOptions = {}): string | null {
	if (!html || typeof window === "undefined") return null;
	return prepareEmailHtml(html, options).html;
}

export function sanitizeEditorHtml(html: string): string {
	return prepareEmailHtml(html, { editor: true }).html;
}
