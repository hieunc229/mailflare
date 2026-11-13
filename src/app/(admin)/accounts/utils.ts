import type { Account } from "./types";

const accountDateFormatter = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
});

const accountDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "numeric",
	minute: "2-digit",
});

export function getAccountInitials(account: Pick<Account, "name" | "email">): string {
	const source = account.name.trim() || account.email;
	return source.slice(0, 1).toUpperCase();
}

export function getAccountMailbox(account: Pick<Account, "localPart" | "hostname" | "email">): string {
	if (account.localPart && account.hostname) return `${account.localPart}@${account.hostname}`;
	return account.email;
}

export function formatAccountDate(value: string): string {
	return accountDateFormatter.format(new Date(value));
}

export function formatAccountDateTime(value: string): string {
	return accountDateTimeFormatter.format(new Date(value));
}
