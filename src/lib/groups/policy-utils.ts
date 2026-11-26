import { getEmailAddress } from "@/lib/email/address";

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
 * Who may post to a group. `org` and `members` need a trusted DMARC pass, because a From header
 * alone is forgeable; `anyone` never looks at the sender.
 */
export function canPost(input: CanPostInput): boolean {
	if (input.whoCanPost === "anyone") return true;
	if (input.dmarc !== "pass") return false;
	const sender = getEmailAddress(input.senderAddress).trim().toLowerCase();
	const at = sender.lastIndexOf("@");
	if (at <= 0 || at === sender.length - 1) return false;
	if (input.whoCanPost === "org") {
		const hostname = sender.slice(at + 1);
		for (const candidate of input.orgHostnames) if (candidate.toLowerCase() === hostname) return true;
		return false;
	}
	for (const candidate of input.memberAddresses) if (candidate.toLowerCase() === sender) return true;
	return false;
}
