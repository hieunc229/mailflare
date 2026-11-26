import { getEmailAddress, splitEmailAddressList } from "@/lib/email/address";

export type WhoCanPost = "anyone" | "org" | "members";

export const GROUP_POST_REJECT_REASON = "5.7.1 You are not allowed to post to this group";

export type CanPostInput = {
	whoCanPost: WhoCanPost;
	/** The From header; a display name is tolerated. */
	senderAddress: string;
	/** The receiver's own DMARC verdict (`readTrustedDmarcResult`). */
	dmarc: "pass" | "fail" | undefined;
	/** Active domains of this installation. */
	orgHostnames: Iterable<string>;
	/** Addresses that count as members, lower-cased. */
	memberAddresses: Iterable<string>;
};

/**
 * The one address of a From header, lower-cased, or null when it holds none or several. A header
 * with several addresses is ambiguous: it must never match an insider because one of them does.
 */
export function singleSenderAddress(header: string | null | undefined): string | null {
	const entries = splitEmailAddressList(header);
	if (entries.length !== 1) return null;
	const address = getEmailAddress(entries[0]).trim().toLowerCase();
	const at = address.lastIndexOf("@");
	return at > 0 && at < address.length - 1 ? address : null;
}

/**
 * Who may post to a group. `org` and `members` need a trusted DMARC pass, because a From header
 * alone is forgeable; `anyone` never looks at the sender.
 */
export function canPost(input: CanPostInput): boolean {
	if (input.whoCanPost === "anyone") return true;
	if (input.dmarc !== "pass") return false;
	const sender = singleSenderAddress(input.senderAddress);
	if (!sender) return false;
	const at = sender.lastIndexOf("@");
	if (input.whoCanPost === "org") {
		const hostname = sender.slice(at + 1);
		for (const candidate of input.orgHostnames) if (candidate.toLowerCase() === hostname) return true;
		return false;
	}
	for (const candidate of input.memberAddresses) if (candidate.toLowerCase() === sender) return true;
	return false;
}
