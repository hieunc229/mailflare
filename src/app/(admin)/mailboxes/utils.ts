import type { Mailbox } from "./types";

export function getMailboxAddress(mailbox: Pick<Mailbox, "localPart" | "hostname">): string {
	return `${mailbox.localPart}@${mailbox.hostname}`;
}

export function getMailboxName(mailbox: Pick<Mailbox, "displayName" | "localPart">): string {
	return mailbox.displayName?.trim() || mailbox.localPart;
}
