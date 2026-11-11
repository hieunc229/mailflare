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
