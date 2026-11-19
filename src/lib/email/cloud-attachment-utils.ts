import type { AttachmentContent } from "./attachment-types";
import { planAttachmentDelivery } from "./attachment-limits";
import { getSharedFilesNotice } from "./attachment-policy";
import type { SendingProvider } from "./outbound-provider-types";
import { SHARED_ATTACHMENT_LINK_DAYS, getOrCreateSharedAttachmentUrl } from "./shared-attachments";
import { sharedFileNotice } from "./shared-file-notice";
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

/**
 * Files the provider cannot carry in the message go out as Shared Files download links (filename and size kept)
 * instead of failing the send. Cloudflare has a 5 MiB message cap; for other providers see `planAttachmentDelivery`.
 */
export async function prepareOutboundAttachments(
	env: CloudflareEnv,
	provider: SendingProvider,
	attachments: AttachmentContent[],
	message: { subject: string; html?: string; text?: string; headers: Record<string, string>; publicOrigin?: string; locale?: string },
): Promise<{ attachments: AttachmentContent[]; html?: string; text?: string }> {
	const encoder = new TextEncoder();
	const baseSize = encoder.encode(message.subject + (message.html ?? "") + (message.text ?? "") + JSON.stringify(message.headers)).byteLength + 8192;
	const plan = planAttachmentDelivery(provider, attachments.map((attachment) => attachment.content.byteLength), baseSize);
	const direct: AttachmentContent[] = [];
	const linked: SharedFileLink[] = [];
	let estimatedSize = baseSize;
	for (const [index, attachment] of attachments.entries()) {
		const size = attachment.content.byteLength;
		if (!plan[index]) {
			direct.push(attachment);
			estimatedSize += Math.ceil(size / 3) * 4 + 2048;
			continue;
		}
		if (!attachment.storageId) throw new Error("Large attachment was not stored in object storage");
		linked.push({ filename: attachment.filename, size, url: await getOrCreateSharedAttachmentUrl(env, attachment.storageId, message.publicOrigin) });
	}
	const cloudflare = provider === "cloudflare";
	if (!linked.length) {
		if (cloudflare && estimatedSize > GENERAL_MESSAGE_LIMIT_BYTES - MIME_SAFETY_MARGIN_BYTES) throw new Error("Message exceeds Cloudflare's 5 MiB email size limit");
		return { attachments: direct, html: message.html, text: message.text };
	}
	const notice = sharedFileNotice(linked, SHARED_ATTACHMENT_LINK_DAYS, await senderTranslator(env, message.locale), await getSharedFilesNotice(env));
	const text = notice.textBlock(message.text);
	const html = `${message.html ?? ""}${notice.htmlBlock}`;
	if (cloudflare && estimatedSize + encoder.encode(notice.text + notice.html + notice.intro + notice.intro).byteLength + 4096 > GENERAL_MESSAGE_LIMIT_BYTES - MIME_SAFETY_MARGIN_BYTES) {
		throw new Error("Message exceeds Cloudflare's 5 MiB email size limit even with download links");
	}
	return { attachments: direct, html, text };
}
