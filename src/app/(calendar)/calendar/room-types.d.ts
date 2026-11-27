export type RoomOption = { id: string; name: string; kind: "room" | "equipment"; capacity: number | null; location: string };

/** A room an event is booked for, as the events API reports it. `conflictAt` is the first clashing date of a declined booking. */
export type EventRoom = { resourceId: string; status: "accepted" | "declined"; conflictAt: string | null };

/** A booking of a room as its schedule lists it: an event the viewer may read in full, or a placeholder that says only that the room is taken. */
export type RoomScheduleEvent = {
	id: string;
	resourceId: string;
	title: string;
	startsAt: string;
	endsAt: string;
	repeat: string;
	repeatDays: string;
	repeatAnchorDay: number | null;
	repeatUntil: string | null;
	rrule: string | null;
	excludedOccurrences: string;
	timeZone: string | null;
	allDay: boolean;
	davObjectId: string | null;
	recurrenceId: string | null;
	color: string | null;
	redacted: boolean;
};

export type RoomListState = "loading" | "error" | "ready";
