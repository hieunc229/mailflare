import type { SessionUser } from "@/lib/auth/types";

export type CalendarToolContext = {
	env: CloudflareEnv;
	user: SessionUser;
	timeZone?: string;
	/** Set only by the in-app confirmation endpoint after the signed-in user approved this exact change. */
	confirmed?: boolean;
};
export type CalendarToolName = "get_schedule" | "search_events" | "get_event" | "create_event" | "update_events" | "delete_events" | "find_free_time" | "get_calendars";
