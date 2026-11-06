import type { Address, Mailbox } from "postal-mime";
import type { EmailAddressParts } from "@/lib/email/address-types";
import { parseAddress } from "@/lib/utils";

function quoteDisplayName(name: string): string {
	return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function formatEmailAddress(address: string, name?: string | null): string {
	const normalizedAddress = address.trim();
	const normalizedName = name?.trim();

	if (!normalizedName) return normalizedAddress;
	return `${quoteDisplayName(normalizedName)} <${normalizedAddress}>`;
}

export function parseEmailAddressParts(value: string): EmailAddressParts {
	const trimmed = value.trim();
	// A quoted display name may contain backslash-escaped quotes and
	// backslashes, as written by formatEmailAddress (`"Maya \"MJ\" Chen"`).
	const headerMatch = trimmed.match(/^(?:"((?:[^"\\]|\\.)*)"|([^<"]+))\s*<([^>]+)>$/);

	if (headerMatch) {
		const quotedName = headerMatch[1]?.replace(/\\(.)/g, "$1");
		return {
			name: (quotedName ?? headerMatch[2] ?? "").trim() || null,
			address: headerMatch[3].trim(),
		};
	}

	return { name: null, address: trimmed };
}

export function getEmailAddress(value: string): string {
	return parseEmailAddressParts(value).address;
}

export function normalizeEmailAddress(value: string): string {
	return getEmailAddress(value).trim().toLowerCase();
}

export function getEmailDisplayName(value: string): string {
	const parts = parseEmailAddressParts(value);
	if (parts.name) return parts.name;

	const parsed = parseAddress(parts.address);
	return parsed?.local || parts.address;
}

export function formatPostalAddress(address: Address | undefined, fallback: string | null): string | null {
	const [mailbox] = getPostalMailboxes(address);
	if (!mailbox?.address) return fallback;

	return formatEmailAddress(mailbox.address, mailbox.name);
}

/**
 * Every mailbox in a header address list, formatted and comma-joined, so that a
 * message's full To/Cc line survives storage and reply-all can see it.
 */
export function formatPostalAddressList(addresses: Address[] | undefined, fallback: string | null): string | null {
	const mailboxes = (addresses ?? []).flatMap(getPostalMailboxes).filter((item) => !!item.address);
	if (mailboxes.length === 0) return fallback;

	return mailboxes.map((mailbox) => formatEmailAddress(mailbox.address, mailbox.name)).join(", ");
}

function getPostalMailboxes(address: Address | undefined): Mailbox[] {
	if (!address) return [];
	if ("address" in address && address.address) return [address];
	return address.group ?? [];
}

/**
 * Split a comma-separated header value into individual addresses, leaving
 * commas inside quoted display names (`"Chen, Maya" <maya@example.com>`) alone.
 */
export function splitEmailAddressList(value: string | null | undefined): string[] {
	const result: string[] = [];
	let current = "";
	let inQuotes = false;
	let inAngle = false;
	let escaped = false;

	for (const char of value ?? "") {
		if (escaped) {
			escaped = false;
			current += char;
			continue;
		}
		if (char === "\\" && inQuotes) {
			escaped = true;
			current += char;
			continue;
		}
		if (char === '"' && !inAngle) inQuotes = !inQuotes;
		else if (char === "<" && !inQuotes) inAngle = true;
		else if (char === ">" && !inQuotes) inAngle = false;

		if ((char === "," || char === ";") && !inQuotes && !inAngle) {
			if (current.trim()) result.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) result.push(current.trim());
	return result;
}

/** Bare, lower-cased addresses from a header list, deduplicated in order. */
export function getEmailAddressList(value: string | null | undefined): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const entry of splitEmailAddressList(value)) {
		const address = normalizeEmailAddress(entry);
		if (!address || seen.has(address)) continue;
		seen.add(address);
		result.push(address);
	}
	return result;
}

export function joinEmailAddressList(values: string[]): string {
	return values.map((value) => value.trim()).filter(Boolean).join(", ");
}

/** The first address of a list, for places that show a single party. */
export function getFirstEmailAddressEntry(value: string | null | undefined): string {
	return splitEmailAddressList(value)[0] ?? (value ?? "").trim();
}
