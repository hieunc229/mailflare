import { getEmailDisplayName, normalizeEmailAddress, parseEmailAddressParts } from "@/lib/email/address";

export function getContactId(userId: string, email: string): string {
	return `${userId}:${email.trim().toLowerCase()}`;
}

export function getContactNameFromAddress(address: string): string | null {
	const name = parseEmailAddressParts(address).name?.trim();
	if (!name) return null;
	return name === normalizeEmailAddress(address) ? null : name;
}

export function getDisplayNameForAddress(address: string, contactName?: string | null): string {
	return contactName?.trim() || getEmailDisplayName(address);
}
