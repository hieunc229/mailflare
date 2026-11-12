export type BookingConfirmationContent = {
	eventName: string;
	hostName: string;
	guestName: string;
	location: string;
	notes: string;
	startsAt: Date;
	endsAt: Date;
	timeZone: string;
};

/** "Tuesday, 18 November 2026, 14:00–14:30 (Europe/Berlin)" in the booking event's own time zone. */
export function formatBookingWhen(startsAt: Date, endsAt: Date, timeZone: string): string {
	let zone = timeZone;
	try {
		new Intl.DateTimeFormat("en-GB", { timeZone: zone });
	} catch {
		zone = "UTC";
	}
	const day = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(startsAt);
	const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
	return `${day}, ${time.format(startsAt)}–${time.format(endsAt)} (${zone})`;
}

export function buildBookingConfirmation(content: BookingConfirmationContent): { subject: string; text: string } {
	const when = formatBookingWhen(content.startsAt, content.endsAt, content.timeZone);
	const lines = [
		`Hi ${content.guestName},`,
		"",
		`your booking is confirmed: ${content.eventName} with ${content.hostName}.`,
		"",
		`When: ${when}`,
		...(content.location ? [`Where: ${content.location}`] : []),
		...(content.notes ? ["", "Your notes:", content.notes] : []),
		"",
		"The attached invitation adds the meeting to your calendar. Reply to this email if you need to change or cancel it.",
	];
	return { subject: `Confirmed: ${content.eventName} with ${content.hostName}`, text: lines.join("\n") };
}
