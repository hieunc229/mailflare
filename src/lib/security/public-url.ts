import { queryDns } from "@/lib/dns-query";
import { isForbiddenHostname, isIpLiteral, isPublicAddress } from "@/lib/remote-images/fetch";

/**
 * Text-level check that a URL we are asked to call points at a public HTTPS host. It cannot see
 * what the name resolves to, so redirects stay disabled at the call site.
 */
export function isPublicHttpsUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && !!url.hostname && !isIpLiteral(url.hostname) && !isForbiddenHostname(url.hostname);
	} catch {
		return false;
	}
}

export const PUBLIC_HTTPS_URL_MESSAGE = "Webhook URLs must use https:// and point at a public host";

/**
 * A public name can still point at a private address. Resolve it (DNS-over-HTTPS) and require every
 * address to be public. There is a short gap between this check and the request itself, which is why
 * redirects stay disabled at the call site.
 */
export async function assertResolvesPublic(hostname: string): Promise<void> {
	const [v4, v6] = await Promise.all([queryDns(hostname, "A"), queryDns(hostname, "AAAA")]);
	const addresses = [...v4, ...v6];
	if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) throw new Error(PUBLIC_HTTPS_URL_MESSAGE);
}
