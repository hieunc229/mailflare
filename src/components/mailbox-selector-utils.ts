import { avatarInitial } from "@/lib/avatar-colors";
import { adminPageTitles } from "./admin-page-titles";
import type { MailboxOption } from "./mailbox-provider";

export function getMailboxAddress(mailbox: MailboxOption): string {
	return `${mailbox.localPart}@${mailbox.hostname}`;
}

export function getMailboxName(mailbox: MailboxOption): string {
	return mailbox.displayName ?? mailbox.localPart;
}

export function getAccountInitial(value: string): string {
	return avatarInitial(value) || "M";
}

export function isAdminPath(pathname: string): boolean {
	return Object.keys(adminPageTitles).some((path) => pathname === path || (path !== "/agent" && pathname.startsWith(`${path}/`)));
}
