import { escapeHtml } from "./shared-file-notice";
import { locales } from "@/lib/i18n/locales";
import type { Locale, Messages } from "@/lib/i18n/types";
import { LOCALE_COOKIE, createTranslator, getDirection, resolveLocale } from "@/lib/i18n/utils";

const registered = Object.keys(locales) as Locale[];

/** The recipient is an outside person with no account: use the language cookie if they have one, else their browser's order of preference. */
export function pickPageLocale(cookieHeader: string | null | undefined, acceptLanguage: string | null | undefined): Locale {
	const cookie = new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`).exec(cookieHeader ?? "")?.[1];
	if (cookie && registered.includes(cookie as Locale)) return resolveLocale(cookie);
	for (const part of (acceptLanguage ?? "").split(",")) {
		const tag = part.split(";")[0].trim().toLowerCase();
		if (!tag || tag === "*") continue;
		const primary = tag.split("-")[0];
		const match = registered.find((code) => code.toLowerCase() === tag)
			?? registered.find((code) => code.toLowerCase() === primary)
			?? registered.find((code) => code.toLowerCase().startsWith(`${primary}-`));
		if (match) return match;
	}
	return resolveLocale(undefined);
}

/**
 * One page for every dead link (expired, turned off, trashed, file gone) so the response says nothing about which
 * it was. No script and no external requests; the sender's name, subject and file name are never included.
 */
export function sharedFileUnavailable(locale: Locale, messages: Partial<Messages> | undefined): Response {
	const t = createTranslator(locale, messages);
	const title = escapeHtml(t("sharedFile.unavailable.title"));
	const html = `<!doctype html><html lang="${locale}" dir="${getDirection(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${title}</title><style>body{margin:0;font:16px/1.5 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;padding:24px;box-sizing:border-box}main{max-width:28rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;opacity:.8}</style></head><body><main><h1>${title}</h1><p>${escapeHtml(t("sharedFile.unavailable.body"))}</p></main></body></html>`;
	return new Response(html, {
		status: 404,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "private, no-store",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
			"X-Content-Type-Options": "nosniff",
			"X-Robots-Tag": "noindex",
			"Referrer-Policy": "no-referrer",
			Vary: "Cookie, Accept-Language",
		},
	});
}
