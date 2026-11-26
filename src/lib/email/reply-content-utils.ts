import type {
	PreviousMessageDirection,
	ReplyContentParts,
	QuotedEmailContent,
	SplitReplyContentOptions,
} from "./reply-content-types";
import { normalizeEmailAddress } from "./address";

const ORIGINAL_MESSAGE_RE = /^-{2,}\s*Original Message\s*-{2,}$/i;
const UNDERSCORE_SEPARATOR_RE = /^_{8,}$/;
const WROTE_RE = /^On\s+(.+?)\s+wrote:\s*$/i;
const MAX_WROTE_LINE_LENGTH = 400;
const MAX_QUOTE_DEPTH = 8;
const HEADER_RE = /^(From|To|Cc|Subject|Date|Sent):\s*(.*)$/i;

// Quoted content is split recursively; the counter bounds nesting so hostile input cannot overflow the stack.
// The split is synchronous, so a module-level counter is safe.
let quoteDepth = 0;

function isWroteLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.length <= MAX_WROTE_LINE_LENGTH && WROTE_RE.test(trimmed);
}

export function splitRepliedEmailContent(
	content: string | null | undefined,
	options: SplitReplyContentOptions = {},
): ReplyContentParts {
	if (quoteDepth >= MAX_QUOTE_DEPTH) return { latestContent: normalizeContent(content).trim(), quotedContent: [] };
	quoteDepth += 1;
	try {
		return splitReplied(content, options);
	} finally {
		quoteDepth -= 1;
	}
}

function splitReplied(
	content: string | null | undefined,
	options: SplitReplyContentOptions,
): ReplyContentParts {
	const lines = normalizeContent(content).split("\n");
	const originalMessageIndex = lines.findIndex((line) => ORIGINAL_MESSAGE_RE.test(line.trim()));
	if (originalMessageIndex >= 0) {
		return splitOriginalMessage(lines, originalMessageIndex, options);
	}

	const underscoreSeparatorIndex = lines.findIndex((line) => UNDERSCORE_SEPARATOR_RE.test(line.trim()));
	if (underscoreSeparatorIndex >= 0) {
		return splitSeparatorQuotedContent(lines, underscoreSeparatorIndex, options);
	}

	const wroteIndex = lines.findIndex(isWroteLine);
	if (wroteIndex >= 0) {
		const markerLine = lines[wroteIndex]?.trim() ?? "";
		const quotedLines = stripSingleQuotePrefix(lines.slice(wroteIndex + 1));
		return {
			latestContent: trimEmptyLines(lines.slice(0, wroteIndex)).join("\n").trim(),
			quotedContent: buildQuotedContent(
				quotedLines,
				getWroteDateLine(markerLine),
				getPreviousMessageDirection(getWroteAddress(markerLine), options.ownAddress),
				options,
			),
		};
	}

	const quoteIndex = lines.findIndex((line) => line.trim().startsWith(">"));
	if (quoteIndex >= 0) {
		const quotedLines = stripSingleQuotePrefix(lines.slice(quoteIndex));
		return {
			latestContent: trimEmptyLines(lines.slice(0, quoteIndex)).join("\n").trim(),
			quotedContent: buildQuotedContent(
				quotedLines,
				"Unknown time",
				"received",
				options,
			),
		};
	}

	return { latestContent: normalizeContent(content).trim(), quotedContent: [] };
}

export function getLatestEmailContent(content: string | null | undefined): string {
	return splitRepliedEmailContent(content).latestContent;
}

const MAX_READABLE_HTML = 250_000;

function stripBlocks(html: string, names: string[]): string {
	const lower = html.toLowerCase();
	const missingClose = new Set<string>();
	let out = "";
	let cursor = 0;
	const open = /<(style|script|head)\b[^>]*>/gi;
	let match: RegExpExecArray | null;
	while ((match = open.exec(html))) {
		const name = match[1].toLowerCase();
		if (match.index < cursor || !names.includes(name)) continue;
		// An unclosed block would otherwise rescan to the end of the input for every opener.
		const close = missingClose.has(name) ? -1 : lower.indexOf(`</${name}`, match.index + match[0].length);
		if (close === -1) {
			missingClose.add(name);
			continue;
		}
		const closeEnd = html.indexOf(">", close);
		out += `${html.slice(cursor, match.index)} `;
		cursor = closeEnd === -1 ? html.length : closeEnd + 1;
		open.lastIndex = cursor;
	}
	return out + html.slice(cursor);
}

/**
 * `decodeAllEntities` is only set for list snippets; the other callers (spam tokenizer, agent context,
 * reply splitter) keep the original small named-entity set so their output does not change.
 */
export function htmlToReadableText(html: string | null | undefined, decodeAllEntities = false): string {
	return stripBlocks((html ?? "").slice(0, MAX_READABLE_HTML), ["style", "script", "head"])
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|tr|blockquote|h[1-6])>/gi, "\n")
		.replace(/<[^<>]*>/g, " ")
		.replace(decodeAllEntities ? /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]*));/gi : /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(nbsp|amp|lt|gt|quot|apos));/gi, decodeEntity);
}

const NAMED_ENTITIES: Record<string, string> = {
	nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'",
	hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
	copy: "\u00a9", reg: "\u00ae", trade: "\u2122", bull: "\u2022", middot: "\u00b7", euro: "\u20ac", laquo: "\u00ab", raquo: "\u00bb",
};

/** Decodes each reference once, so `&amp;lt;` stays the text `&lt;`; invalid code points are left as written. */
function decodeEntity(match: string, decimal: string | undefined, hex: string | undefined, name: string | undefined): string {
	if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
	const code = decimal ? Number(decimal) : Number.parseInt(hex ?? "", 16);
	return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : match;
}

function splitOriginalMessage(
	lines: string[],
	markerIndex: number,
	options: SplitReplyContentOptions,
): ReplyContentParts {
	const latestContent = trimEmptyLines(lines.slice(0, markerIndex)).join("\n").trim();
	const quotedLines = lines.slice(markerIndex + 1);
	const headers = new Map<string, string>();
	let contentStartIndex = 0;

	for (let index = 0; index < quotedLines.length; index += 1) {
		const line = quotedLines[index] ?? "";
		if (!line.trim()) {
			contentStartIndex = index + 1;
			break;
		}

		const match = line.match(HEADER_RE);
		if (match) {
			headers.set(match[1].toLowerCase(), match[2].trim());
			contentStartIndex = index + 1;
		}
	}

	const quotedContent = buildQuotedContent(
		stripSingleQuotePrefix(quotedLines.slice(contentStartIndex)),
		headers.get("date") ?? headers.get("sent") ?? "Unknown time",
		getPreviousMessageDirection(headers.get("from"), options.ownAddress),
		options,
	);

	return { latestContent, quotedContent };
}

function splitSeparatorQuotedContent(
	lines: string[],
	separatorIndex: number,
	options: SplitReplyContentOptions,
): ReplyContentParts {
	const quotedLines = trimEmptyLines(lines.slice(separatorIndex + 1));
	return {
		latestContent: trimEmptyLines(lines.slice(0, separatorIndex)).join("\n").trim(),
		quotedContent: buildQuotedContent(
			quotedLines,
			getHeaderValue(quotedLines, "sent") ?? getHeaderValue(quotedLines, "date") ?? "Unknown time",
			getPreviousMessageDirection(getHeaderValue(quotedLines, "from"), options.ownAddress),
			options,
		),
	};
}

function getWroteDateLine(line: string): string {
	const match = line.match(WROTE_RE);
	const rawDateLine = match?.[1]?.trim() ?? "";
	return rawDateLine
		.replace(/,\s*["']?[^,<"]+["']?\s*<[^>]+>\s*$/i, "")
		.replace(/\b([0-9]{1,2}:[0-9]{2}\s?(?:AM|PM))(?:,?\s+.*)?$/i, "$1")
		.trim() || "Unknown time";
}

function getWroteAddress(line: string): string | undefined {
	return line.match(/<([^>]+@[^>]+)>/)?.[1];
}

function normalizeContent(content: string | null | undefined): string {
	return (content ?? "").replace(/\r\n?/g, "\n");
}

function stripSingleQuotePrefix(lines: string[]): string[] {
	return trimEmptyLines(lines.map((line) => line.replace(/^\s*>\s?/, "")));
}

function trimEmptyLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;

	while (start < end && !lines[start]?.trim()) start += 1;
	while (end > start && !lines[end - 1]?.trim()) end -= 1;

	return lines.slice(start, end);
}

function hasQuotedContent(quotedContent: QuotedEmailContent): boolean {
	return (
		quotedContent.content.trim().length > 0 ||
		quotedContent.quotedContent.length > 0
	);
}

function buildQuotedContent(
	lines: string[],
	dateLine: string,
	direction: PreviousMessageDirection,
	options: SplitReplyContentOptions,
): QuotedEmailContent[] {
	const rawContent = trimEmptyLines(lines).join("\n").trim();
	if (!rawContent) return [];

	const nested = splitRepliedEmailContent(rawContent, options);
	const quotedContent: QuotedEmailContent = {
		dateLine,
		direction,
		content: nested.latestContent,
		quotedContent: nested.quotedContent,
	};

	return hasQuotedContent(quotedContent) ? [quotedContent] : [];
}

function getPreviousMessageDirection(
	from: string | undefined,
	ownAddress: string | undefined,
): PreviousMessageDirection {
	if (!from || !ownAddress) return "received";
	const fromAddress = normalizeEmailAddress(
		from.match(/<([^>]+)>/)?.[1] ?? from,
	);
	return fromAddress === normalizeEmailAddress(ownAddress) ? "sent" : "received";
}

function getHeaderValue(lines: string[], name: string): string | undefined {
	for (const line of lines) {
		const match = line.match(HEADER_RE);
		if (match?.[1].toLowerCase() === name) return match[2].trim();
	}
	return undefined;
}
