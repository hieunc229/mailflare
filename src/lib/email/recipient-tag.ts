import { splitEmailAddressList } from "@/lib/email/address";
import { parseAddress } from "@/lib/utils";
import { parseRecipientAddress } from "./recipient-address";

/**
 * The verbatim `+tag` of a recipient address: `base+my.tag@x` yields `my.tag`.
 * `localPart` is dot- and case-normalized for mailbox matching, but the tag is a
 * label the sender chose, so it is read from the raw local part with its dots
 * kept. "" when the address carries no usable tag, including an empty `base+`.
 */
export function getRecipientTag(address: string | null | undefined): string {
	if (!address) return "";
	const parsed = parseRecipientAddress(address);
	if (!parsed?.hasSubaddress) return "";
	const local = parseAddress(address)?.local ?? "";
	return local.slice(local.indexOf("+") + 1);
}

/** The first `+tag` across a header's recipient list; "" when none carries one. */
export function getRecipientTagFromList(value: string | null | undefined): string {
	for (const entry of splitEmailAddressList(value)) {
		const tag = getRecipientTag(entry);
		if (tag) return tag;
	}
	return "";
}
