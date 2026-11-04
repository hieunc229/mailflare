import type { ContactDisplayName } from "@/lib/contacts/types";
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
 * The sender label for one message. A name the user set on the contact wins,
 * then the message's own From header, then a name learned from other mail from
 * the same address. A shared address such as a recruiting no-reply can carry a
 * different company name on every message, so the header must beat the
 * contact's last-learned name.
 */
export function getSenderDisplayName(address: string, contact?: ContactDisplayName | null): string | null {
	const contactName = contact?.displayName.trim() || null;
	if (contact?.source === "manual" && contactName) return contactName;
	return getContactNameFromAddress(address) ?? contactName;
}
