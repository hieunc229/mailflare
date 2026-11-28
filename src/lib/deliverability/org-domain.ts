import { getDomain, parse } from "tldts";
import { getEmailAddressList } from "@/lib/email/address";

/**
 * Organisational domain from the Public Suffix List, private suffixes included (`example.eu.org`, `alice.github.io`),
 * so tenants of a shared suffix are never one organisation. A host that is itself a public suffix, an IP address or
 * has no valid name gives null.
 */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function organisationalDomain(host: string): string | null {
	const name = host.trim().toLowerCase().replace(/\.$/, "");
	if (!HOST.test(name)) return null;
	return publicSuffixDomain(name);
}

/** The registrable domain under the same list, without the strict ASCII host check (internationalised names pass). */
export function publicSuffixDomain(name: string): string | null {
	return getDomain(name, { allowPrivateDomains: true });
}

/** True when the name is itself a public suffix (`co.uk`, `github.io`), which no one owns. */
export function isPublicSuffix(name: string): boolean {
	const parsed = parse(name, { allowPrivateDomains: true });
	return !parsed.isIp && parsed.domain === null && parsed.publicSuffix === name;
}

/** The organisational domain of the one address in a `From` header or contact email, or null when there is not exactly one. */
export function addressOrganisation(value: string | null | undefined): string | null {
	const addresses = getEmailAddressList(value);
	if (addresses.length !== 1) return null;
	const at = addresses[0].lastIndexOf("@");
	return at < 0 ? null : organisationalDomain(addresses[0].slice(at + 1));
}
