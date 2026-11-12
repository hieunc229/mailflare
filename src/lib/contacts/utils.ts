import type { ContactNameSource } from "@/lib/contacts/types";
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

/**
 * The label for one party of a message, sender or recipient. A name the user
 * set on the contact wins, then the message's own header name, then a name
 * learned from other mail for the same address. A shared address such as a
 * recruiting no-reply can carry a different company name on every message, so
 * the header must beat the contact's last-learned name.
 */
export function getPartyDisplayName(address: string, contact?: ContactNameSource | null): string | null {
	const contactName = contact?.displayName?.trim() || null;
	if (contact?.source === "manual" && contactName) return contactName;
	return getContactNameFromAddress(address) ?? contactName;
}
