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
