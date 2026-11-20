/** `response_status` is null for events the user made, else the answer to an invitation or the state a DAV client set. */
export const INACTIVE_CALENDAR_RESPONSES = ["declined", "cancelled"] as const;
/** Everything that is not on the calendar: the inactive states plus invitations still waiting for an answer. */
export const OFF_CALENDAR_RESPONSES = ["needs-action", ...INACTIVE_CALENDAR_RESPONSES] as const;

/** Declined and cancelled events are hidden everywhere: they do not show, remind or block booking slots. */
export function isInactiveCalendarResponse(status: string | null | undefined): boolean {
	return status === "declined" || status === "cancelled";
}

/** Not on the subscription feed, the DAV calendar or the booking busy list. */
export function isOffCalendarResponse(status: string | null | undefined): boolean {
	return status === "needs-action" || isInactiveCalendarResponse(status);
}
