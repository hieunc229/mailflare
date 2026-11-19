import type { AttachmentContent } from "./attachment-types";
import { CLOUD_ATTACHMENT_THRESHOLD_BYTES } from "./attachment-policy";
import { SHARED_ATTACHMENT_LINK_DAYS, getOrCreateSharedAttachmentUrl } from "./shared-attachments";
import { escapeHtml, sharedFileNotice } from "./shared-file-notice";
import type { SharedFileLink } from "./shared-file-notice";
import { createTranslator, defaultTranslator, loadMessages, resolveLocale } from "@/lib/i18n/utils";
import type { Translator } from "@/lib/i18n/utils";

const GENERAL_MESSAGE_LIMIT_BYTES = 5 * 1024 * 1024;
const MIME_SAFETY_MARGIN_BYTES = 256 * 1024;

/** The sender's catalog through the static assets binding; English when it is unset or cannot be read. */
async function senderTranslator(env: CloudflareEnv, value: string | undefined): Promise<Translator> {
	const locale = resolveLocale(value);
	try {
		return createTranslator(locale, await loadMessages(locale, (path) => env.ASSETS.fetch(new URL(path, "https://mailflare.local"))));
	} catch {
		return defaultTranslator;
	}
}

export async function prepareCloudflareAttachments(
	env: CloudflareEnv,
	attachments: AttachmentContent[],
	message: { subject: string; html?: string; text?: string; headers: Record<string, string>; publicOrigin?: string; locale?: string },
): Promise<{ attachments: AttachmentContent[]; html?: string; text?: string }> {
	const encoder = new TextEncoder();
	let estimatedSize = encoder.encode(message.subject + (message.html ?? "") + (message.text ?? "") + JSON.stringify(message.headers)).byteLength + 8192;
	const direct: AttachmentContent[] = [];
	const linked: SharedFileLink[] = [];
	for (const attachment of attachments) {
		const size = attachment.content.byteLength;
		const encodedSize = Math.ceil(size / 3) * 4 + 2048;
		if (size <= CLOUD_ATTACHMENT_THRESHOLD_BYTES && estimatedSize + encodedSize <= GENERAL_MESSAGE_LIMIT_BYTES - MIME_SAFETY_MARGIN_BYTES) {
			direct.push(attachment);
			estimatedSize += encodedSize;
			continue;
		}
		if (!attachment.storageId) throw new Error("Large attachment was not stored in object storage");
		linked.push({ filename: attachment.filename, size, url: await getOrCreateSharedAttachmentUrl(env, attachment.storageId, message.publicOrigin) });
	}
	if (!linked.length) {
		if (estimatedSize > GENERAL_MESSAGE_LIMIT_BYTES - MIME_SAFETY_MARGIN_BYTES) throw new Error("Message exceeds Cloudflare's 5 MiB email size limit");
		return { attachments: direct, html: message.html, text: message.text };
	}
	const { intro, text: textLinks, html: htmlLinks } = sharedFileNotice(linked, SHARED_ATTACHMENT_LINK_DAYS, await senderTranslator(env, message.locale));
	const text = [message.text?.trim(), intro, textLinks].filter(Boolean).join("\n\n");
	const html = `${message.html ?? ""}<div><p>${escapeHtml(intro)}</p><ul>${htmlLinks}</ul></div>`;
	if (estimatedSize + encoder.encode(textLinks + htmlLinks + intro + intro).byteLength + 4096 > GENERAL_MESSAGE_LIMIT_BYTES - MIME_SAFETY_MARGIN_BYTES) {
		throw new Error("Message exceeds Cloudflare's 5 MiB email size limit even with download links");
	}
	return { attachments: direct, html, text };
}
