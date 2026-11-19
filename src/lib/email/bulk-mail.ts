/** Header names and values come from different intake paths, so lookups ignore case. */
export type MailHeaders = Record<string, string | undefined | null>;

export type BulkMailResult = {
	bulk: boolean;
	/** Which signals fired, as `header` or `header: value`, in a stable order. Empty when not bulk. */
	reasons: string[];
};

/** Precedence values that mark mass mail (RFC 2076 and common practice). */
const BULK_PRECEDENCE = /^(bulk|list|junk)$/;

/**
 * Headers that only mass-mailing tools set. Anything an ESP adds to every message it
 * relays, transactional receipts included (`X-SES-Outgoing`, `X-SG-EID`, `X-Mailgun-Tag`,
 * `X-Mailer`), is deliberately left out, so a password reset or order receipt that passes
 * through the same provider as a newsletter is not caught.
 */
const CAMPAIGN_HEADERS = ["x-campaign", "x-campaign-id", "x-campaignid"];

export function getMailHeader(headers: MailHeaders | undefined | null, name: string): string {
	if (!headers) return "";
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() !== name) continue;
		const value = headers[key];
		return typeof value === "string" ? value.trim() : "";
	}
	return "";
}

/** `List-Id` present, or `Precedence: bulk|list|junk`. The part auto-reply suppression uses. */
export function hasListOrBulkPrecedence(headers: MailHeaders | undefined | null): boolean {
	return !!getMailHeader(headers, "list-id") || BULK_PRECEDENCE.test(getMailHeader(headers, "precedence").toLowerCase());
}

/**
 * Decides whether a message is newsletter, promotional or mailing-list mail from its
 * headers alone, so it can run at SMTP time, before the body is parsed.
 *
 * `bulk` is true when any of these is present:
 * - `List-Unsubscribe`: RFC 2369 unsubscribe link, required of bulk senders by Gmail and Yahoo.
 * - `List-Id`: RFC 2919 mailing-list identifier.
 * - `Precedence: bulk`, `list` or `junk`.
 * - `X-Campaign` or `X-Campaign-ID`: campaign tags set by marketing tools.
 *
 * `Feedback-ID` is recorded in `reasons` when one of those is also present, but never
 * decides on its own: SES, Postmark and Google stamp it on transactional mail (one-time
 * codes, receipts) as well as on campaigns.
 *
 * Not bulk on their own: `Feedback-ID`, `Auto-Submitted` (auto-replies and notifications are machine mail,
 * not promotions), `X-Auto-Response-Suppress`, and per-message ESP trace headers.
 * A plain personal message carries none of the above. Some transactional receipts do
 * (Shopify and Stripe often add `List-Unsubscribe`), so they can match; rules that act
 * on this result must stay non-destructive.
 *
 * Contract for callers: `headers` is the lower- or mixed-case header map of the inbound
 * message (the `headers` of an inbound queue payload). Missing headers mean `bulk: false`,
 * never an error. The result is advisory classification: it changes no state. A future
 * Promotions view can reuse it as is; `reasons` explains each hit.
 */
export function isBulkMail(headers: MailHeaders | undefined | null): BulkMailResult {
	const reasons: string[] = [];
	if (getMailHeader(headers, "list-unsubscribe")) reasons.push("list-unsubscribe");
	if (getMailHeader(headers, "list-id")) reasons.push("list-id");
	const precedence = getMailHeader(headers, "precedence").toLowerCase();
	if (BULK_PRECEDENCE.test(precedence)) reasons.push(`precedence: ${precedence}`);
	for (const name of CAMPAIGN_HEADERS) {
		if (getMailHeader(headers, name)) reasons.push(name);
	}
	const bulk = reasons.length > 0;
	if (bulk && getMailHeader(headers, "feedback-id")) reasons.push("feedback-id");
	return { bulk, reasons };
}

export type BulkMailVerdict = {
	/** Exactly `isBulkMail(headers).bulk`. */
	bulk: boolean;
	/**
	 * `list`: a discussion list (`List-Post`, or `Precedence: list` with `List-Id`).
	 * `marketing`: bulk but not a discussion list.
	 * `null`: not bulk.
	 */
	kind: "marketing" | "list" | null;
	/** `isBulkMail` signal names (header only, no value). */
	signals: string[];
};

/**
 * Classifies one message for the Promotions view from its headers alone. Strong signals are exactly
 * `isBulkMail`'s, so routing rules and Promotions never disagree about what is bulk. ESP trace headers
 * (`X-SES-Outgoing`, `X-SG-EID`, ...) and a footer unsubscribe link are deliberately not signals:
 * receipts and password resets carry both.
 */
export function detectBulkMail(headers: MailHeaders | undefined | null): BulkMailVerdict {
	const { bulk, reasons } = isBulkMail(headers);
	const signals = reasons.map((reason) => reason.split(":")[0]);
	const discussionList = !!getMailHeader(headers, "list-post") || (!!getMailHeader(headers, "list-id") && getMailHeader(headers, "precedence").toLowerCase() === "list");
	const kind = !bulk ? null : discussionList ? "list" : "marketing";
	return { bulk, kind, signals };
}
