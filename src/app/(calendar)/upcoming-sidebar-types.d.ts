import type { CalendarEvent } from "./calendar/types";

export type UpcomingSidebarProps = {
	events?: CalendarEvent[];
	onSelect?: (event: CalendarEvent) => void;
	/** Render only the list, for the mobile menu drawer. */
	drawer?: boolean;
	/** Refetch (keeping the current list on screen) when this value changes. */
	refreshKey?: unknown;
};
