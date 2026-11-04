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
const HEADER_RE = /^(From|To|Cc|Subject|Date|Sent):\s*(.*)$/i;

export function splitRepliedEmailContent(
	content: string | null | undefined,
	options: SplitReplyContentOptions = {},
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

	const wroteIndex = lines.findIndex((line) => WROTE_RE.test(line.trim()));
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

export function htmlToReadableText(html: string | null | undefined): string {
	return stripBlocks((html ?? "").slice(0, MAX_READABLE_HTML), ["style", "script", "head"])
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|tr|blockquote|h[1-6])>/gi, "\n")
		.replace(/<[^<>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&#39;/g, "'");
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
