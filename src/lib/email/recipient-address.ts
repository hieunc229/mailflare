import { parseAddress } from "@/lib/utils";
import type { ParsedRecipientAddress } from "./recipient-address-types";

/**
 * Dot- and case-normalized local part with any `+tag` kept: `U.Ser+Tag` becomes
 * `user+tag`. Delivery tries this form first so a literal `user+tag` mailbox or
 * alias beats the `user` base address.
 */
export function normalizeRecipientFullLocalPart(localPart: string): string {
	return localPart
		.replaceAll(".", "")
		.toLowerCase();
}

export function normalizeRecipientLocalPart(localPart: string): string {
	const [baseLocalPart] = normalizeRecipientFullLocalPart(localPart).split("+", 1);
	return baseLocalPart;
}

export function parseRecipientAddress(address: string): ParsedRecipientAddress | null {
	const parsed = parseAddress(address);
	if (!parsed) return null;

	const localPart = normalizeRecipientFullLocalPart(parsed.local);
	// The subaddress splits at the first "+". An empty tag (`user+@…`) does not
	// split, and a missing base (`+tag@…`) is not a deliverable address.
	const separator = localPart.indexOf("+");
	const hasSubaddress = separator > -1 && separator < localPart.length - 1;
	const baseLocalPart = separator === -1 ? localPart : localPart.slice(0, separator);
	if (!baseLocalPart) return null;

	return {
		original: address,
		localPart,
		baseLocalPart,
		hasSubaddress,
		domain: parsed.domain,
		normalizedAddress: `${localPart}@${parsed.domain}`,
		normalizedBaseAddress: `${baseLocalPart}@${parsed.domain}`,
	};
}
