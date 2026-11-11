import { getEmailAddress, joinEmailAddressList, parseEmailAddressParts, splitEmailAddressList } from "@/lib/email/address";

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function isValidRecipient(entry: string): boolean {
	return EMAIL_RE.test(getEmailAddress(entry).trim());
}

/** Turn raw typed text into recipient entries, deduplicated by bare address. */
export function parseRecipientEntries(value: string, existing: string[] = []): string[] {
	const seen = new Set(existing.map((entry) => getEmailAddress(entry).toLowerCase()));
	const result: string[] = [];
	for (const entry of splitEmailAddressList(value)) {
		const key = getEmailAddress(entry).toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
	}
	return result;
}

/** Appends entries the list does not already have, deduplicated by bare address. */
export function mergeRecipients(current: string[], additions: string[]): string[] {
	return [...current, ...parseRecipientEntries(additions.join(", "), current)];
}

export function recipientsToHeader(entries: string[]): string {
	return joinEmailAddressList(entries);
}

export function headerToRecipients(value: string | null | undefined): string[] {
	return parseRecipientEntries(value ?? "");
}

/** Short label for a chip: the display name if there is one, else the address. */
export function getRecipientLabel(entry: string): string {
	const parts = parseEmailAddressParts(entry);
	return parts.name && parts.name !== parts.address ? parts.name : parts.address;
}
