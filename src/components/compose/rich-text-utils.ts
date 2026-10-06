/**
 * Helpers for the HTML composer. The editor owns one HTML string; the plain-text
 * alternative and the draft/send payloads are all derived from it, so there is
 * a single source of truth for what the message says.
 */

import { sanitizeEmailHtml } from "@/app/(dashboard)/inbox/[messageId]/email-html-sanitizer";
import type { TextDirection } from "./rich-text-editor-types";

export const QUOTE_ATTRIBUTE = "data-mailflare-quote";
const QUOTE_OPEN = `<div class="mailflare-quote" ${QUOTE_ATTRIBUTE}="1">`;
export const SIGNATURE_ATTRIBUTE = "data-mailflare-signature";

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// Hebrew, Arabic, Syriac, Thaana, N'Ko and the other right-to-left scripts,
// with their presentation forms.
const RTL_CHARACTERS = "\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFF\\u{10800}-\\u{10FFF}\\u{1E800}-\\u{1EFFF}";
const RTL_CHARACTER_RE = new RegExp(`[${RTL_CHARACTERS}]`, "u");
const FIRST_STRONG_RE = new RegExp(`[${RTL_CHARACTERS}]|\\p{L}`, "u");

/**
 * The direction of the first strong character, the rule dir="auto" applies.
 * Null when the text has no letters (empty, digits or punctuation only).
 */
export function detectTextDirection(text: string | null | undefined): TextDirection | null {
	const match = FIRST_STRONG_RE.exec(text ?? "");
	if (!match) return null;
	return RTL_CHARACTER_RE.test(match[0]) ? "rtl" : "ltr";
}

export function containsRtlText(text: string | null | undefined): boolean {
	return RTL_CHARACTER_RE.test(text ?? "");
}

/**
 * Explicit direction markup for a block. Mail clients disagree about
 * dir="auto" and Outlook ignores the attribute without the inline style, so
 * outgoing mail always carries both.
 */
function directionAttributes(direction: TextDirection): string {
	return ` dir="${direction}" style="direction: ${direction}; text-align: ${direction === "rtl" ? "right" : "left"}"`;
}

function textLinesToHtml(value: string): string {
	return escapeHtml(value).replace(/\n/g, "<br>");
}

/** Plain text as HTML: escaped, with line breaks preserved and right-to-left text marked. */
export function textToHtml(text: string | null | undefined): string {
	const value = (text ?? "").replace(/\r\n?/g, "\n");
	if (!value) return "";
	const direction = detectTextDirection(value);
	return `<div${direction === "rtl" ? directionAttributes(direction) : ""}>${textLinesToHtml(value)}</div>`;
}

/** Wrap quoted or forwarded content so the composer and reader can fold it. */
export function wrapQuotedHtml(inner: string): string {
	return `${QUOTE_OPEN}${inner}</div>`;
}

/** Split a stored HTML body into the editable part and the folded quote, if any. */
export function splitQuotedHtml(html: string | null | undefined): { body: string; quoted: string | null } {
	const value = html ?? "";
	const index = value.indexOf(QUOTE_OPEN);
	if (index < 0) return { body: value, quoted: null };
	const inner = value.slice(index + QUOTE_OPEN.length).replace(/<\/div>\s*$/, "");
	return { body: value.slice(0, index), quoted: inner };
}

export function joinQuotedHtml(body: string, quoted: string | null): string {
	return quoted ? `${body}${wrapQuotedHtml(quoted)}` : body;
}

/** True when the HTML carries something other than empty blocks and whitespace. */
export function hasMeaningfulHtml(html: string): boolean {
	return htmlToPlainText(html).trim().length > 0 || /<img\b/i.test(html);
}

/** Distinguish stored HTML markup from existing plain-text signatures. */
export function isHtmlSignature(signature: string | null | undefined): boolean {
	return /<\/?[a-z][a-z0-9]*[\s>/]/i.test(signature ?? "");
}

export function signatureToHtml(signature: string | null | undefined): string {
	const value = signature?.trim() ?? "";
	if (!value) return "";
	if (isHtmlSignature(value) && typeof DOMParser !== "undefined") {
		return sanitizeEmailHtml(value, { forOutgoing: true }) ?? "";
	}
	const lines = textLinesToHtml(value.replace(/\r\n?/g, "\n"));
	return detectTextDirection(value) === "rtl" ? `<div${directionAttributes("rtl")}>${lines}</div>` : lines;
}

function signatureBlock(signature: string | null | undefined): string {
	const html = signatureToHtml(signature);
	return html ? `<div ${SIGNATURE_ATTRIBUTE}="1"><br><br>${html}</div>` : "";
}

/** Swap or append the mailbox signature, mirroring the plain-text behaviour. */
export function applyMailboxSignatureHtml(
	html: string,
	previousSignature: string | null | undefined,
	nextSignature: string | null | undefined,
): string {
	const previousBlock = signatureBlock(previousSignature);
	const nextBlock = signatureBlock(nextSignature);
	if (previousBlock && html.includes(previousBlock)) return html.replace(previousBlock, nextBlock);
	if (!nextBlock || html.includes(nextBlock)) return html;
	return `${html}${nextBlock}`;
}

const BLOCK_TAGS = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "ul", "ol", "table"]);

/**
 * The text/plain alternative of a composed message. Blocks become lines, lists
 * get bullets or numbers, blockquotes get the classic "> " prefix so reply
 * chains stay readable in text-only clients and in Mailflare's own reader.
 */
export function htmlToPlainText(html: string | null | undefined): string {
	if (!html) return "";
	if (typeof DOMParser === "undefined") {
		return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "");
	}
	const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
	const text = renderNode(doc.body, { listDepth: 0, ordered: [] });
	return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

type RenderState = { listDepth: number; ordered: Array<number | null> };

function renderNode(node: Node, state: RenderState): string {
	if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
	if (node.nodeType !== Node.ELEMENT_NODE) return "";
	const element = node as HTMLElement;
	const tag = element.tagName.toLowerCase();
	if (tag === "br") return "\n";
	if (tag === "style" || tag === "script" || tag === "head") return "";

	if (tag === "ul" || tag === "ol") {
		const next: RenderState = { listDepth: state.listDepth + 1, ordered: [...state.ordered, tag === "ol" ? 0 : null] };
		const items = Array.from(element.children)
			.map((child) => {
				const index = next.ordered.length - 1;
				if (next.ordered[index] !== null) next.ordered[index] = (next.ordered[index] ?? 0) + 1;
				const marker = next.ordered[index] !== null ? `${next.ordered[index]}. ` : "- ";
				const indent = "  ".repeat(state.listDepth);
				return `${indent}${marker}${renderChildren(child, next).trim()}`;
			})
			.join("\n");
		return `\n${items}\n`;
	}

	let inner = renderChildren(element, state);
	if (tag === "a") {
		const href = element.getAttribute("href") ?? "";
		if (href && href !== inner.trim() && !href.startsWith("mailto:")) inner = `${inner} (${href})`;
	}
	if (tag === "blockquote") {
		const quoted = inner
			.trim()
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n");
		return `\n${quoted}\n`;
	}
	if (BLOCK_TAGS.has(tag)) return `\n${inner}\n`;
	return inner;
}

function renderChildren(element: Element, state: RenderState): string {
	return Array.from(element.childNodes)
		.map((child) => renderNode(child, state))
		.join("");
}

export const DIRECTION_BLOCK_SELECTOR = "div, p, li, ul, ol, blockquote, h1, h2, h3, h4, h5, h6, pre, td, th";

function isDirectionBlock(node: Node): boolean {
	return node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(DIRECTION_BLOCK_SELECTOR);
}

/** Give loose text beside blocks its own block, so it can carry a direction like the composer's first line. */
function wrapInlineRuns(container: Element): void {
	const children = Array.from(container.childNodes);
	if (container.tagName !== "BODY" && !children.some(isDirectionBlock)) return;
	let run: ChildNode[] = [];
	const flush = () => {
		if (run.some((node) => (node.textContent ?? "").trim())) {
			const wrapper = container.ownerDocument.createElement("div");
			run[0].before(wrapper);
			for (const node of run) wrapper.appendChild(node);
		}
		run = [];
	};
	for (const child of children) {
		if (isDirectionBlock(child)) flush();
		else run.push(child);
	}
	flush();
}

/**
 * A list follows its first item: dir="auto" cannot resolve it, because every
 * item carries its own dir and auto resolution skips those.
 */
export function listDirection(list: Element): TextDirection | null {
	const first = list.querySelector(":scope > li");
	const chosen = first?.getAttribute("dir");
	if (chosen === "rtl" || chosen === "ltr") return chosen;
	return detectTextDirection((first ?? list).textContent);
}

function explicitDirection(element: Element): TextDirection | null {
	const value = element.closest("[dir]")?.getAttribute("dir")?.toLowerCase();
	return value === "rtl" || value === "ltr" ? value : null;
}

const AUTO_DIRECTION_RE = /\sdir="auto"/g;
const CHOSEN_DIRECTION_RE = /\sdir\s*=\s*["']?(?:rtl|ltr)\b/i;

/**
 * Resolve the composer's per-paragraph direction into explicit markup for mail
 * clients. The editor marks each paragraph dir="auto" unless the writer chose a
 * direction, but mail clients disagree about "auto", so this stamps the direction
 * it resolves to on every block and Gmail, Outlook and Apple Mail render what the
 * writer saw. Messages with no right-to-left text and no chosen direction go out
 * as plain markup, exactly as before.
 */
export function applyOutgoingTextDirection(html: string): string {
	if (!html) return html;
	if ((!containsRtlText(html) && !CHOSEN_DIRECTION_RE.test(html)) || typeof DOMParser === "undefined") {
		return html.replace(AUTO_DIRECTION_RE, "");
	}
	const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
	wrapInlineRuns(doc.body);
	for (const container of Array.from(doc.body.querySelectorAll(DIRECTION_BLOCK_SELECTOR))) wrapInlineRuns(container);
	// Resolve every block before stamping any, so a stamped list does not read as
	// a chosen direction for its own items.
	const resolved = Array.from(doc.body.querySelectorAll<HTMLElement>(DIRECTION_BLOCK_SELECTOR))
		.filter((element) => element.tagName === "UL" || element.tagName === "OL" || !element.querySelector(DIRECTION_BLOCK_SELECTOR))
		.map((element) => ({
			element,
			direction: element.tagName === "UL" || element.tagName === "OL"
				? listDirection(element)
				: explicitDirection(element) ?? detectTextDirection(element.textContent),
		}));
	for (const { element, direction } of resolved) {
		if (!direction) continue;
		element.setAttribute("dir", direction);
		element.style.direction = direction;
		if (!element.style.textAlign) element.style.textAlign = direction === "rtl" ? "right" : "left";
	}
	for (const element of Array.from(doc.body.querySelectorAll('[dir="auto"]'))) element.removeAttribute("dir");
	return doc.body.innerHTML;
}
