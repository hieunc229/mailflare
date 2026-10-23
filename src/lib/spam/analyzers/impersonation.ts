import { getEmailAddress } from "@/lib/email/address";
import { domainOwnerLabel, isLookalikeDomain, registrableDomain } from "../domain-utils";
import type { SpamBrand, SpamSignal } from "../types";
import { SPAM_WEIGHTS } from "../weights";

type BrandMatcher = { pattern: RegExp; owners: string[] };

/**
 * Global brands phishing commonly pretends to be, with the owner labels of the domains they really send from.
 * Regional banks, carriers and telcos are added per installation in the admin spam filter settings.
 */
const BRANDS: BrandMatcher[] = [
	{ pattern: /\bpaypal\b/i, owners: ["paypal", "paypal-communication", "paypalobjects"] },
	{ pattern: /\bapple\b|\bicloud\b|\bitunes\b/i, owners: ["apple", "icloud", "me", "mac", "itunes"] },
	{ pattern: /\bmicrosoft\b|\boffice ?365\b|\bonedrive\b/i, owners: ["microsoft", "office", "office365", "outlook", "live", "hotmail", "microsoftonline", "sharepoint", "onedrive", "azure"] },
	{ pattern: /\bgoogle\b|\bgmail\b/i, owners: ["google", "gmail", "googlemail", "youtube"] },
	{ pattern: /\bamazon\b|\baws\b/i, owners: ["amazon", "amazonaws", "amazonses", "aws"] },
	{ pattern: /\bnetflix\b/i, owners: ["netflix"] },
	{ pattern: /\bdhl\b/i, owners: ["dhl"] },
	{ pattern: /\bfedex\b/i, owners: ["fedex"] },
	{ pattern: /\bups\b/i, owners: ["ups"] },
	{ pattern: /\bdpd\b/i, owners: ["dpd"] },
	{ pattern: /\brevolut\b/i, owners: ["revolut"] },
	{ pattern: /\bcoinbase\b/i, owners: ["coinbase"] },
	{ pattern: /\bbinance\b/i, owners: ["binance"] },
	{ pattern: /\bdocusign\b/i, owners: ["docusign"] },
	{ pattern: /\bdropbox\b/i, owners: ["dropbox", "dropboxmail"] },
	{ pattern: /\blinkedin\b/i, owners: ["linkedin"] },
	{ pattern: /\bfacebook\b|\bmeta\b|\binstagram\b|\bwhatsapp\b/i, owners: ["facebook", "facebookmail", "meta", "metamail", "instagram", "whatsapp"] },
];

function customBrandMatcher(brand: SpamBrand): BrandMatcher {
	const name = brand.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
	return { pattern: new RegExp(`(?<![\\p{L}\\p{N}])${name}(?![\\p{L}\\p{N}])`, "iu"), owners: brand.domains.map(domainOwnerLabel) };
}

function displayName(from: string | null | undefined): string {
	const match = (from ?? "").match(/^\s*"?([^"<]*?)"?\s*</);
	return match?.[1]?.trim() ?? "";
}

/**
 * Sender impersonation: a display name that claims a brand or another address, and sender domains made to
 * look like a domain the user really corresponds with (`paypa1.com`, `rnicrosoft.com`).
 * `knownDomains` are domains the user has written to or owns.
 */
export function analyzeImpersonation(from: string | null | undefined, knownDomains: string[], customBrands: SpamBrand[] = []): SpamSignal[] {
	const address = getEmailAddress(from ?? "").toLowerCase();
	const senderDomain = address.includes("@") ? address.slice(address.lastIndexOf("@") + 1) : "";
	if (!senderDomain) return [];
	const signals: SpamSignal[] = [];
	const name = displayName(from);
	const owner = domainOwnerLabel(senderDomain);

	if (name) {
		const brand = [...customBrands.map(customBrandMatcher), ...BRANDS].find((item) => item.pattern.test(name));
		if (brand && !brand.owners.some((label) => owner === label || owner.startsWith(`${label}-`) || owner.endsWith(`-${label}`))) {
			signals.push({ id: "brand_display_name", score: SPAM_WEIGHTS.impersonation.brandDisplayName, reason: "The sender name claims a well-known brand the sending domain does not belong to", metadata: { name } });
		}
		const claimed = name.match(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/)?.[1]?.toLowerCase();
		if (claimed && registrableDomain(claimed) !== registrableDomain(senderDomain)) {
			signals.push({ id: "address_in_display_name", score: SPAM_WEIGHTS.impersonation.addressInDisplayName, reason: "The sender name shows a different email address than the one the message is from" });
		}
	}

	const known = new Set(knownDomains.map((domain) => registrableDomain(domain)));
	if (!known.has(registrableDomain(senderDomain))) {
		const imitated = [...known].find((domain) => isLookalikeDomain(senderDomain, domain));
		if (imitated) {
			signals.push({ id: "lookalike_domain", score: SPAM_WEIGHTS.impersonation.lookalikeDomain, reason: `The sender domain imitates ${imitated}, a domain you correspond with`, metadata: { imitated } });
		}
	}
	return signals;
}
