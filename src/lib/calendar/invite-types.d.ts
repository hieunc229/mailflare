import type { InviteResponse } from "./invite";

export type { InviteResponse };

/** The invitation fields the message card renders. */
export type InviteView = {
	title: string;
	description: string;
	location: string;
	startsAt: string;
	endsAt: string;
	allDay: boolean;
	organizer: string | null;
	method: string;
	/** Set when this invitation is about one occurrence of a recurring series. */
	recurrenceId?: string | null;
	attendees?: { email: string; status: string }[];
};

/** A message's invitation plus the calendar state for the current user. */
export type InviteCardData = {
	invite: InviteView;
	eventId: string | null;
	response: InviteResponse | null;
	canRespond?: boolean;
	/** When the answer last changed, from the calendar row; absent for unanswered or declined answers. */
	answeredAt?: string | null;
};
