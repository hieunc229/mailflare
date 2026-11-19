import { getEmailAddress } from "@/lib/email/address";
import type { ParsedEmail } from "@/lib/email/parse";
import { registrableDomain } from "../domain-utils";
import type { PreparedSpamContent, SpamSignal } from "../types";
import { SPAM_WEIGHTS } from "../weights";

/** Each entry is one kind of search-optimisation or traffic pitch; a message must match at least two kinds. */
const PITCH_PATTERNS: RegExp[] = [
	/\b(?:submit|list|add|register)\b[^\n]{0,70}\bto\b[^\n]{0,20}\bsearch engines?\b/i,
	/\b(?:rank(?:ing|ings)?|first page|page one|top (?:spot|position|results?))\b[^.\n]{0,40}\bgoogle\b/i,
	/\b(?:quality |cheap |high[- ]da |premium )?backlinks?\b/i,
	/\b(?:boost|increase|improve|grow|drive)\b[^.\n]{0,30}\b(?:traffic|rankings?|visibility|seo)\b/i,
	/\bseo (?:audit|services?|packages?|report|expert|specialist|campaign)\b/i,
	/\bguaranteed (?:rankings?|traffic|results|visitors)\b/i,
];

/** Bare domains the recipient could be addressed at, from To and Cc. */
function recipientDomains(message: ParsedEmail): string[] {
	const result = new Set<string>();
	for (const part of `${message.toAddr ?? ""},${message.ccAddr ?? ""}`.split(",")) {
		const address = getEmailAddress(part).toLowerCase();
		const domain = address.includes("@") ? address.slice(address.lastIndexOf("@") + 1) : "";
		if (domain.includes(".")) result.add(registrableDomain(domain));
	}
	return [...result];
}

/** True when the text names `domain` as a site, not as part of an email address such as the recipient's own. */
function mentions(text: string, domain: string): boolean {
	const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\w.@-])(?:www\\.)?${escaped}(?![\\w-])`, "i").test(text);
}

/**
 * Cold outreach selling search or traffic services for the recipient's own site. Deliberately narrow: it only
 * fires for a first-contact sender, a message that is not a reply and carries no List-Unsubscribe header,
 * names the recipient's registrable domain, and matches two different pitch patterns.
 */
export function analyzeSolicitation(message: ParsedEmail, prepared: PreparedSpamContent, options: { firstContact: boolean; hasUnsubscribe: boolean }): SpamSignal[] {
	if (!options.firstContact || options.hasUnsubscribe || message.inReplyTo || message.references.length > 0) return [];
	const text = prepared.visibleText;
	if (!recipientDomains(message).some((domain) => mentions(text, domain))) return [];
	if (PITCH_PATTERNS.filter((pattern) => pattern.test(text)).length < 2) return [];
	return [{ id: "unsolicited_solicitation", score: SPAM_WEIGHTS.content.coldSolicitation, reason: "First-time sender is pitching search or traffic services for your own website" }];
}
