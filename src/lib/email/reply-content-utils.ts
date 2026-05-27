import type { ReplyContentParts, QuotedEmailContent } from "./reply-content-types";

const ORIGINAL_MESSAGE_RE = /^-{2,}\s*Original Message\s*-{2,}$/i;
const UNDERSCORE_SEPARATOR_RE = /^_{8,}$/;
const WROTE_RE = /^On\s+(.+?)\s+wrote:\s*$/i;
const HEADER_RE = /^(From|To|Cc|Subject|Date|Sent):\s*(.*)$/i;

export function splitRepliedEmailContent(content: string | null | undefined): ReplyContentParts {
	const lines = normalizeContent(content).split("\n");
	const originalMessageIndex = lines.findIndex((line) => ORIGINAL_MESSAGE_RE.test(line.trim()));
	if (originalMessageIndex >= 0) {
		return splitOriginalMessage(lines, originalMessageIndex);
	}

	const underscoreSeparatorIndex = lines.findIndex((line) => UNDERSCORE_SEPARATOR_RE.test(line.trim()));
	if (underscoreSeparatorIndex >= 0) {
		return splitSeparatorQuotedContent(lines, underscoreSeparatorIndex);
	}

	const wroteIndex = lines.findIndex((line) => WROTE_RE.test(line.trim()));
	if (wroteIndex >= 0) {
		const markerLine = lines[wroteIndex]?.trim() ?? "";
		return {
			latestContent: trimEmptyLines(lines.slice(0, wroteIndex)).join("\n").trim(),
			quotedContent: [
				{
					dateLine: getWroteDateLine(markerLine),
					content: stripQuotePrefixes(lines.slice(wroteIndex + 1)).join("\n").trim(),
				},
			].filter(hasQuotedContent),
		};
	}

	const quoteIndex = lines.findIndex((line) => line.trim().startsWith(">"));
	if (quoteIndex >= 0) {
		return {
			latestContent: trimEmptyLines(lines.slice(0, quoteIndex)).join("\n").trim(),
			quotedContent: [
				{
					dateLine: "Previous message",
					content: stripQuotePrefixes(lines.slice(quoteIndex)).join("\n").trim(),
				},
			].filter(hasQuotedContent),
		};
	}

	return { latestContent: normalizeContent(content).trim(), quotedContent: [] };
}

export function getLatestEmailContent(content: string | null | undefined): string {
	return splitRepliedEmailContent(content).latestContent;
}

export function htmlToReadableText(html: string | null | undefined): string {
	return (html ?? "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|tr|blockquote|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&#39;/g, "'");
}

function splitOriginalMessage(lines: string[], markerIndex: number): ReplyContentParts {
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

	const quotedContent: QuotedEmailContent[] = [
		{
			dateLine: headers.get("date") ?? headers.get("sent") ?? "Previous message",
			content: stripQuotePrefixes(quotedLines.slice(contentStartIndex)).join("\n").trim(),
		},
	].filter(hasQuotedContent);

	return { latestContent, quotedContent };
}

function splitSeparatorQuotedContent(lines: string[], separatorIndex: number): ReplyContentParts {
	return {
		latestContent: trimEmptyLines(lines.slice(0, separatorIndex)).join("\n").trim(),
		quotedContent: [
			{
				dateLine: "Previous message",
				content: trimEmptyLines(lines.slice(separatorIndex + 1)).join("\n").trim(),
			},
		].filter(hasQuotedContent),
	};
}

function getWroteDateLine(line: string): string {
	const match = line.match(WROTE_RE);
	const rawDateLine = match?.[1]?.trim() ?? "";
	return rawDateLine
		.replace(/,\s*["']?[^,<"]+["']?\s*<[^>]+>\s*$/i, "")
		.replace(/\b([0-9]{1,2}:[0-9]{2}\s?(?:AM|PM))(?:,?\s+.*)?$/i, "$1")
		.trim() || "Previous message";
}

function normalizeContent(content: string | null | undefined): string {
	return (content ?? "").replace(/\r\n?/g, "\n");
}

function stripQuotePrefixes(lines: string[]): string[] {
	return trimEmptyLines(lines.map((line) => line.replace(/^\s*>+\s?/, "")));
}

function trimEmptyLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;

	while (start < end && !lines[start]?.trim()) start += 1;
	while (end > start && !lines[end - 1]?.trim()) end -= 1;

	return lines.slice(start, end);
}

function hasQuotedContent(quotedContent: QuotedEmailContent): boolean {
	return quotedContent.content.trim().length > 0;
}
