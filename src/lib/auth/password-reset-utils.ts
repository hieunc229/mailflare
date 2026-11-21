import type { Translator } from "@/lib/i18n/utils";

export function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildPasswordResetEmail(
	t: Translator,
	{ email, appName, link, minutes }: { email: string; appName: string; link: string; minutes: number },
): { subject: string; text: string; html: string } {
	const ignore = t("auth.resetMail.ignore");
	return {
		subject: t("auth.resetMail.subject", { appName }),
		text: [
			t("auth.resetMail.intro", { email, appName }),
			"",
			t("auth.resetMail.instructions", { minutes }),
			link,
			"",
			ignore,
		].join("\n"),
		html: `<p>${t("auth.resetMail.intro", { email: `<b>${escapeHtml(email)}</b>`, appName: escapeHtml(appName) })}</p><p>${escapeHtml(t("auth.resetMail.instructions", { minutes }))}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>${escapeHtml(ignore)}</p>`,
	};
}

/**
 * The origin a reset link may point at. The link carries a live credential, so it must never come from
 * a header the requester controls. APP_URL wins. Without it, Workers still know their public origin
 * (the edge rejects other Host values), but the self-hosted server builds `request.url` from the Host
 * header, so there is no trusted origin and the caller must not send the mail.
 */
export function trustedResetOrigin(env: { APP_URL?: string; MAILFLARE_RUNTIME?: string }, requestUrl: string): string | null {
	const configured = env.APP_URL?.trim();
	if (configured) {
		try {
			return new URL(configured).origin;
		} catch {
			return null;
		}
	}
	if (env.MAILFLARE_RUNTIME === "node") return null;
	return new URL(requestUrl).origin;
}
