import type { MailtoUnsubscribeTarget } from "./types";

const ONE_CLICK_TIMEOUT_MS = 10_000;

/**
 * RFC 8058 one-click: POST `List-Unsubscribe=One-Click` to the https URI.
 * Any 2xx or 3xx counts as success. Redirects are followed because an
 * opaqueredirect reports status 0 outside Workers and would read as a failure.
 */
export async function postOneClickUnsubscribe(url: string): Promise<boolean> {
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "List-Unsubscribe=One-Click",
			redirect: "follow",
			signal: AbortSignal.timeout(ONE_CLICK_TIMEOUT_MS),
		});
		return response.status >= 200 && response.status < 400;
	} catch {
		return false;
	}
}

/** Pulls the recipient out of a `mailto:` candidate, honouring its subject/body params for automated processors. */
export function parseMailtoUnsubscribe(url: string): MailtoUnsubscribeTarget | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "mailto:") return null;
		const to = decodeURIComponent(parsed.pathname).trim();
		if (!to) return null;
		return {
			to,
			subject: parsed.searchParams.get("subject")?.trim() || "unsubscribe",
			text: parsed.searchParams.get("body")?.trim() || "unsubscribe",
		};
	} catch {
		return null;
	}
}
