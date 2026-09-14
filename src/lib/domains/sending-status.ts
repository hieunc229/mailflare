import type { CfSendingSubdomain } from "@/lib/cloudflare-api.types";
import { toAsciiHostname } from "@/lib/email/idn";

export function findSendingSubdomain(
	hostname: string,
	subdomains: CfSendingSubdomain[],
): CfSendingSubdomain | null {
	// Cloudflare registers a symbol domain under its ASCII spelling, so both sides
	// are compared in that form.
	const normalizedHostname = toAsciiHostname(hostname);
	const exact = subdomains.find(
		(subdomain) => toAsciiHostname(subdomain.name) === normalizedHostname,
	);
	if (exact) return exact;

	return subdomains.find((subdomain) => {
		const normalizedName = subdomain.name.toLowerCase();
		if (!normalizedName.startsWith("*.")) return false;

		const baseDomain = toAsciiHostname(normalizedName.slice(2));
		return normalizedHostname !== baseDomain && normalizedHostname.endsWith(`.${baseDomain}`);
	}) ?? null;
}
