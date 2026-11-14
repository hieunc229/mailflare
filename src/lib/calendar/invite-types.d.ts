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
	attendees?: { email: string; status: string }[];
};

/** A message's invitation plus the calendar state for the current user. */
export type InviteCardData = {
	invite: InviteView;
	eventId: string | null;
	response: InviteResponse | null;
	canRespond?: boolean;
};
