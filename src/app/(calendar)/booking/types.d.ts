import type { BookingTimeRange } from "@/lib/booking/types";

export type BookingEvent = {
	id: string;
	userId: string;
	name: string;
	slug: string;
	description: string;
	color: string;
	hostIds: string;
	/** JSON list of room ids; absent on the default (not yet saved) events. */
	resourceIds?: string;
	durationMinutes: number;
	location: string;
	weekdays: string;
	startTime: string;
	endTime: string;
	timeRanges: string;
	timeZone: string;
	enabled: boolean;
	/** The event's own guest confirmation; empty uses the built-in text. */
	confirmationSubject?: string;
	confirmationBody?: string;
	isTemplate?: true;
};

export type BookingForm = {
	name: string;
	slug: string;
	description: string;
	color: string;
	hostIds: string[];
	resourceIds: string[];
	durationMinutes: number;
	location: string;
	weekdays: number[];
	startTime: string;
	endTime: string;
	timeRanges: BookingTimeRange[];
	timeZone: string;
	enabled: boolean;
	confirmationSubject: string;
	confirmationBody: string;
};

export type BookingHost = { id: string; name: string; email: string; hasAvatar?: boolean };

export type BookingHostAvatarProps = { host: BookingHost; currentUserId: string; size?: "small" | "medium" };

export type BookingHostMatch = { host: BookingHost | null; error: string };

export type BookingEditorSection = "event" | "duration" | "location" | "availability" | "host" | "rooms" | "confirmation" | null;
