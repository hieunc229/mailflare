import type { Translator } from "@/lib/i18n/utils";
import { defaultTranslator } from "@/lib/i18n/utils";

export const SHARED_NOTICE_MAX_LENGTH = 500;
export const DEFAULT_SHARED_LINK_DAYS = 30;
const MIN_SHARED_LINK_DAYS = 1;
const MAX_SHARED_LINK_DAYS = 365;

export type SharedFileLink = { filename: string; size: number; type?: string; url: string; expiresAt?: Date };

export type SharedNoticeOptions = {
	/** false removes the introductory sentence; the cards stay. */
	enabled?: boolean;
	/** Administrator's own sentence; `{days}` becomes the link lifetime. Empty or null uses the translated default. */
	text?: string | null;
	/** Link lifetime in days, also what `{days}` states. */
	days?: number;
	/** "card" renders attachment-like cards, "links" keeps a plain list. */
	style?: "card" | "links";
	/** Translator to use; when absent the default (English) one is used. */
	t?: Translator;
};

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

/** A usable link lifetime: whole days between 1 and 365, the default when the value is unusable. */
export function clampSharedLinkDays(value: number | null | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SHARED_LINK_DAYS;
	return Math.min(Math.max(Math.trunc(value), MIN_SHARED_LINK_DAYS), MAX_SHARED_LINK_DAYS);
}

/** Human readable size: bytes below a kilobyte, whole kilobytes below a megabyte, one decimal above. */
export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0 KB";
	if (bytes < 1000) return `${Math.round(bytes)} B`;
	if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
	return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

const TYPE_BADGES: { test: (type: string) => boolean; label: string; color: string }[] = [
	{ test: (type) => type.startsWith("image/"), label: "IMG", color: "#7c3aed" },
	{ test: (type) => type === "application/pdf", label: "PDF", color: "#dc2626" },
	{ test: (type) => type.includes("spreadsheet") || type.includes("ms-excel"), label: "XLS", color: "#15803d" },
	{ test: (type) => type.includes("presentation") || type.includes("ms-powerpoint"), label: "PPT", color: "#c2410c" },
	{ test: (type) => type.includes("word") || type.includes("opendocument.text"), label: "DOC", color: "#1d4ed8" },
	{ test: (type) => type.includes("zip") || type.includes("compressed") || type.includes("tar") || type.includes("rar"), label: "ZIP", color: "#a16207" },
	{ test: (type) => type.startsWith("audio/"), label: "AUD", color: "#0f766e" },
	{ test: (type) => type.startsWith("video/"), label: "VID", color: "#be185d" },
	{ test: (type) => type.startsWith("text/") || type.includes("json") || type.includes("javascript"), label: "TXT", color: "#475569" },
];

/** Extension shown next to the size: the filename's own, else the subtype of the MIME type. */
export function fileExtension(filename: string, type?: string): string {
	const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1];
	if (fromName) return fromName.toUpperCase();
	const subtype = type?.split("/")[1]?.split(/[;+]/)[0];
	return subtype ? subtype.toUpperCase().slice(0, 8) : "";
}

/**
 * The badge Outlook keeps: a table cell with a solid background and letters, never a flex box or an image.
 * Office files keep their real extension (XLSX, DOCX, PPTX) instead of a generic category.
 */
function badge(type: string | undefined, ext: string): { label: string; color: string } {
	const match = type ? TYPE_BADGES.find((entry) => entry.test(type.toLowerCase())) : undefined;
	if (!match) return { label: ext.slice(0, 4) || "FILE", color: "#6b7280" };
	// XLSX/DOCX/PPTX read wrong as XLS/DOC/PPT, so a specific extension wins over the generic label.
	const specific = ext.length <= 4 && !["XLS", "DOC", "PPT"].includes(ext);
	return { label: specific ? ext : match.label, color: match.color };
}

/**
 * The block appended to a message whose large files went out as download links: an optional sentence followed by one
 * card per file (or a plain list). Email clients only keep tables and inline styles, so each card is a three-cell
 * table wrapped in a single anchor: the whole card downloads the file and nothing depends on JavaScript.
 */
export function sharedFileNotice(files: SharedFileLink[], opts: SharedNoticeOptions = {}) {
	const t = opts.t ?? defaultTranslator;
	const enabled = opts.enabled ?? true;
	const days = clampSharedLinkDays(opts.days);
	const style = opts.style === "links" ? "links" : "card";
	const custom = opts.text?.trim().slice(0, SHARED_NOTICE_MAX_LENGTH) ?? "";

	const intro = !enabled ? "" : custom ? custom.replace(/\{days\}/g, String(days)) : t("attachment.sharedIntro", { days });
	const download = t("attachment.sharedDownload");
	const expires = t("attachment.sharedExpires", { days });

	const rows = files.map((file) => {
		const name = escapeHtml(file.filename);
		const href = escapeHtml(file.url);
		const ext = fileExtension(file.filename, file.type);
		const size = formatFileSize(file.size);
		const details = escapeHtml([ext, size].filter(Boolean).join(" · "));
		return { name, href, size, details, ...badge(file.type, ext) };
	});

	const introHtml = intro ? escapeHtml(intro).replace(/\r?\n/g, "<br>") : "";
	const text = rows.map((row) => `${row.name} (${row.details}): ${row.href}`).join("\n");

	if (style === "links") {
		const html = rows.map((row) => `<li>${row.name} (${row.details}): <a href="${row.href}">${escapeHtml(download)}</a></li>`).join("");
		const htmlBlock = `<div>${introHtml ? `<p>${introHtml}</p>` : ""}<ul>${html}</ul></div>`;
		const textBlock = (body?: string) => [body?.trim(), intro, text].filter(Boolean).join("\n\n");
		return { intro, text, html: htmlBlock, htmlBlock, textBlock };
	}

	// Each card: [badge][filename + extension and size + expiry][download], the three inside one anchor.
	const cards = rows
		.map(
			(row) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin:0 0 8px 0;border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;background-color:#f9fafb;">
<tr><td style="padding:0;">
<a href="${row.href}" style="display:block;padding:12px;text-decoration:none;color:#111827;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;">
<tr>
<td width="52" valign="middle" style="width:52px;padding:0 12px 0 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td align="center" valign="middle" width="40" height="40" bgcolor="${row.color}" style="width:40px;height:40px;background-color:${row.color};border-radius:6px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;letter-spacing:0.5px;text-align:center;">${row.label}</td></tr></table></td>
<td valign="middle" style="padding:0;"><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#111827;line-height:18px;word-break:break-word;">${row.name}</div><div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b7280;line-height:16px;padding-top:2px;">${row.details}</div>${enabled ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#9ca3af;line-height:14px;padding-top:2px;">${escapeHtml(expires)}</div>` : ""}</td>
<td width="120" align="right" valign="middle" height="100%" style="width:120px;padding:0 0 0 12px;vertical-align:middle;text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#2563eb;white-space:nowrap;">${escapeHtml(download)}</td>
</tr>
</table>
</a>
</td></tr>
</table>`,
		)
		.join("");

	const htmlBlock = `<div style="margin-top:16px;font-family:Arial,Helvetica,sans-serif;">${introHtml ? `<div style="font-size:13px;color:#374151;padding-bottom:8px;">${introHtml}</div>` : ""}${cards}</div>`;
	const textBlock = (body?: string) => [body?.trim(), intro, enabled ? expires : "", text].filter(Boolean).join("\n\n");
	return { intro, text, html: htmlBlock, htmlBlock, textBlock };
}
