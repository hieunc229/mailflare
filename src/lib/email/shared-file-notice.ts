import { renderBookingTemplate } from "@/lib/booking/confirmation-utils";
import { defaultTranslator } from "@/lib/i18n/utils";
import type { Translator } from "@/lib/i18n/utils";

export type SharedFileLink = { filename: string; size: number; url: string };

export { MAX_SHARED_FILES_NOTICE_LENGTH } from "./attachment-limits";

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

/**
 * The note appended to a message whose large files went out as download links.
 * `customIntro` is the administrator's text ({days} is the link lifetime): null/undefined means the default in the
 * sender's language, an empty text means no message at all (the links stay). It is escaped in the HTML part.
 */
export function sharedFileNotice(files: SharedFileLink[], linkDays: number, t: Translator = defaultTranslator, customIntro?: string | null) {
	const custom = customIntro == null ? null : renderBookingTemplate(customIntro, { days: String(linkDays) }).trim();
	const intro = custom ?? t("attachment.sharedIntro", { days: linkDays });
	const download = t("attachment.sharedDownload");
	const size = (file: SharedFileLink) => `${(file.size / 1_000_000).toFixed(1)} MB`;
	const text = files.map((file) => `${file.filename} (${size(file)}): ${file.url}`).join("\n");
	const html = files.map((file) => `<li>${escapeHtml(file.filename)} (${size(file)}): <a href="${escapeHtml(file.url)}">${escapeHtml(download)}</a></li>`).join("");
	const htmlBlock = `<div>${intro ? `<p>${escapeHtml(intro).replace(/\r?\n/g, "<br>")}</p>` : ""}<ul>${html}</ul></div>`;
	const textBlock = (body?: string) => [body?.trim(), intro, text].filter(Boolean).join("\n\n");
	return { intro, text, html, htmlBlock, textBlock };
}
