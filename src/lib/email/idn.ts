/**
 * Internationalised domain names have two spellings: the one a person types
 * (π2.com) and the ASCII/punycode one SMTP actually delivers to
 * (xn--2-tmb.com). A domain is stored as typed so the UI keeps the readable
 * form, but inbound mail always arrives in punycode, so every comparison
 * between the two has to happen on a single normalised form.
 */
export function toAsciiHostname(hostname: string): string {
	const normalized = hostname.trim().toLowerCase();
	if (!normalized) return normalized;
	try {
		// The URL parser performs the IDNA conversion and is a no-op for hostnames
		// that are already ASCII.
		return new URL(`http://${normalized}`).hostname;
	} catch {
		return normalized;
	}
}

/** Lower-cases an address and normalises its domain to punycode. */
export function toAsciiAddress(address: string): string {
	const trimmed = address.trim().toLowerCase();
	const at = trimmed.lastIndexOf("@");
	if (at < 0) return trimmed;
	return `${trimmed.slice(0, at)}@${toAsciiHostname(trimmed.slice(at + 1))}`;
}

/**
 * Normalises the domain of a header address while leaving any display name
 * alone, so `Aba <aba@π2.com>` goes onto the wire as `Aba <aba@xn--2-tmb.com>`.
 * Cloudflare authorises sending against the ASCII spelling, so the readable
 * form is kept for storage and display only.
 */
export function toAsciiHeaderAddress(address: string): string {
	const match = address.trim().match(/^(.*)<([^>]+)>$/);
	if (!match) return toAsciiAddress(address);
	return `${match[1]}<${toAsciiAddress(match[2])}>`;
}
