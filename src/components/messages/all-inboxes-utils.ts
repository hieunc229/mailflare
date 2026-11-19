import type { MailboxOption } from "@/components/mailbox-provider";

export type MailboxChip = {
	label: string;
	/** Full address, shown on hover. */
	title: string;
	className: string;
};

// Picked by position, not by a hash of the id, so the first six mailboxes never share a tint.
const CHIP_TINTS = [
	"bg-blue-100 text-blue-800",
	"bg-amber-100 text-amber-800",
	"bg-emerald-100 text-emerald-800",
	"bg-violet-100 text-violet-800",
	"bg-rose-100 text-rose-800",
	"bg-cyan-100 text-cyan-800",
];

export function shouldShowAllInboxes(mailboxes: readonly unknown[]): boolean {
	return mailboxes.length >= 2;
}

export function getMailboxChips(
	mailboxes: readonly Pick<MailboxOption, "id" | "localPart" | "hostname" | "displayName">[],
): Map<string, MailboxChip> {
	return new Map(mailboxes.map((mailbox, index) => [mailbox.id, {
		label: mailbox.displayName?.trim() || mailbox.localPart,
		title: `${mailbox.localPart}@${mailbox.hostname}`,
		className: CHIP_TINTS[index % CHIP_TINTS.length],
	}]));
}
