import { parseFragment } from "parse5";

const ALLOWED = new Set(["div", "p", "br", "b", "strong", "i", "em", "u", "s", "strike", "del", "ul", "ol", "li", "blockquote", "a", "span"]);

type NoteNode = {
	nodeName: string;
	value?: string;
	attrs?: { name: string; value: string }[];
	childNodes?: NoteNode[];
};

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** http(s), mailto, and tel only. Anything else is dropped. */
function safeHref(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (!["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) return null;
		return url.href;
	} catch {
		return null;
	}
}

function render(node: NoteNode): string {
	if (node.nodeName === "#text") return escapeHtml(node.value ?? "");
	const tag = node.nodeName.toLowerCase();
	if (tag === "script" || tag === "style" || tag === "iframe" || tag === "object" || tag === "embed" || tag === "noscript") return "";
	const children = (node.childNodes ?? []).map(render).join("");
	if (!ALLOWED.has(tag)) return children;
	if (tag === "br") return "<br>";
	if (tag === "a") {
		const href = safeHref(node.attrs?.find((attr) => attr.name === "href")?.value ?? "");
		if (!href) return children;
		return `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${children}</a>`;
	}
	return `<${tag}>${children}</${tag}>`;
}

function visibleText(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/gi, " ")
		.trim();
}

/**
 * Store a note as a small HTML fragment. Plain text is escaped. Markup is
 * reduced to the same formatting the composer toolbar can produce.
 */
export function sanitizeNoteHtml(input: string): string {
	const value = input.replace(/\r\n?/g, "\n").trim();
	if (!value) return "";
	const html = /<\/?[a-z]/i.test(value)
		? (parseFragment(value).childNodes as NoteNode[]).map(render).join("").trim()
		: `<div>${escapeHtml(value).replace(/\n/g, "<br>")}</div>`;
	return visibleText(html) ? html : "";
}
