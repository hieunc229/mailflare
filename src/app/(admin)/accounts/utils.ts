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

export function formatAccountDate(value: string): string {
	return accountDateFormatter.format(new Date(value));
}

export function formatAccountDateTime(value: string): string {
	return accountDateTimeFormatter.format(new Date(value));
}
