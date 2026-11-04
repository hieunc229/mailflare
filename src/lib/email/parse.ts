import PostalMime from "postal-mime";
import { formatPostalAddress, formatPostalAddressList } from "@/lib/email/address";
import { normalizeMessageId, parseMessageIdList } from "@/lib/email/threading";
import { MIME_LIMITS, mimePreflightReason } from "@/lib/email/mime-preflight";
import { normalizeAttachmentContent } from "@/lib/email/attachments";
import { getLatestEmailContent, htmlToReadableText } from "@/lib/email/reply-content-utils";
import type { AttachmentContent } from "@/lib/email/attachment-types";

export type ParsedEmail = {
	subject: string | null;
	text: string | null;
	html: string | null;
	messageId: string | null;
	fromAddr: string | null;
	/** Full To header, comma-joined. */
	toAddr: string | null;
	/** Full Cc header, comma-joined. */
	ccAddr: string | null;
	/** Full Bcc header, comma-joined. Only present on mail composed locally, never on delivered mail. */
	bccAddr: string | null;
	/** Full Reply-To header, comma-joined. */
	replyTo: string | null;
	inReplyTo: string | null;
	references: string[];
	date: Date | null;
	attachments: AttachmentContent[];
};

/** Mail that can never parse within bounds; retrying it only repeats the work. */
export class MimeLimitError extends Error {}

export async function parseRawMime(raw: ArrayBuffer): Promise<ParsedEmail> {
	// Every caller (inbound, import, JMAP) gets the cheap structural check before any decode.
	const limitReason = mimePreflightReason(raw);
	if (limitReason) throw new MimeLimitError(limitReason);
	// forceRfc822Attachments keeps postal-mime from re-parsing inline message/rfc822 with fresh
	// options, which would reset the nesting cap at every level.
	const email = await PostalMime.parse(raw, {
		maxNestingDepth: MIME_LIMITS.maxNestingDepth,
		maxHeadersSize: MIME_LIMITS.maxHeaderBytes,
		forceRfc822Attachments: true,
	});
	const date = email.date ? new Date(email.date) : null;
	return {
		subject: email.subject ?? null,
		text: email.text ?? null,
		html: email.html ?? null,
		messageId: email.messageId ?? null,
		fromAddr: formatPostalAddress(email.from, null),
		toAddr: formatPostalAddressList(email.to, null),
		ccAddr: formatPostalAddressList(email.cc, null),
		bccAddr: formatPostalAddressList(email.bcc, null),
		replyTo: formatPostalAddressList(email.replyTo, null),
		inReplyTo: normalizeMessageId(email.inReplyTo),
		references: parseMessageIdList(email.references),
		date: date && !Number.isNaN(date.getTime()) ? date : null,
		attachments: email.attachments.map((attachment, index) => ({
			filename: attachment.filename ?? `attachment-${index + 1}`,
			type: attachment.mimeType || "application/octet-stream",
			content: normalizeAttachmentContent(attachment.content, attachment.encoding),
			disposition: attachment.disposition === "inline" ? "inline" : "attachment",
			contentId: attachment.contentId ?? null,
		})),
	};
}

export function buildSnippet(text: string | null, html: string | null, max = 200): string {
	const source = getLatestEmailContent(text?.trim() || htmlToReadableText(html));
	return source.replace(/\s+/g, " ").trim().slice(0, max);
}
