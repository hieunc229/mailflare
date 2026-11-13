/**
 * Canonical form of a domain name: trimmed, lowercase, no trailing dot, and
 * punycode for internationalised names (Cloudflare zone names are punycode).
 * Input the URL parser cannot read is returned trimmed and lowercased so a
 * validity check can reject it.
 */
export function normalizeHostname(hostname: string): string {
	const trimmed = hostname.trim().toLowerCase().replace(/\.+$/, "");
	if (!trimmed || /[\s/@:?#\\]/.test(trimmed)) return trimmed;
	try {
		return new URL(`http://${trimmed}`).hostname.replace(/\.+$/, "");
	} catch {
		return trimmed;
	}
}

const HOSTNAME_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A domain name, not an IP address: top-level domains are never all digits, which also catches forms the URL parser turns into IPv4 ("0x7f.1"). */
export function isValidHostname(hostname: string): boolean {
	return HOSTNAME_PATTERN.test(hostname) && !/^\d+$/.test(hostname.slice(hostname.lastIndexOf(".") + 1));
}

export function getZoneLookupCandidates(hostname: string): string[] {
	const labels = hostname.split(".").filter(Boolean);
	const candidates: string[] = [];

	for (let index = 0; index <= labels.length - 2; index += 1) {
		candidates.push(labels.slice(index).join("."));
	}

	return candidates;
}

export function isZoneApex(hostname: string, zoneName: string): boolean {
	return hostname === zoneName;
}

/**
 * Owners whose domains a user sees. A mailbox manager sees the creator's domains,
 * but domains they added themselves are recorded under their own id, so both count.
 */
export function domainListOwnerIds(user: { id: string; canManageMailboxes: boolean; createdByUserId: string | null }): string[] {
	return user.canManageMailboxes && user.createdByUserId && user.createdByUserId !== user.id
		? [user.id, user.createdByUserId]
		: [user.id];
}
