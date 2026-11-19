import { defaultTranslator } from "@/lib/i18n/utils";
import type { Translator } from "@/lib/i18n/utils";

export type SharedFileLink = { filename: string; size: number; url: string };

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

/** The note appended to a message whose large files went out as download links, in the sender's language. */
export function sharedFileNotice(files: SharedFileLink[], linkDays: number, t: Translator = defaultTranslator) {
	const intro = t("attachment.sharedIntro", { days: linkDays });
	const download = t("attachment.sharedDownload");
	const size = (file: SharedFileLink) => `${(file.size / 1_000_000).toFixed(1)} MB`;
	const text = files.map((file) => `${file.filename} (${size(file)}): ${file.url}`).join("\n");
	const html = files.map((file) => `<li>${escapeHtml(file.filename)} (${size(file)}): <a href="${escapeHtml(file.url)}">${escapeHtml(download)}</a></li>`).join("");
	return { intro, text, html };
}
