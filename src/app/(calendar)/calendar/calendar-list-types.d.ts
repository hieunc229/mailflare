import type { CalendarSummary } from "@/lib/calendar/calendars-types";

export type CalendarListState = "loading" | "ready" | "error";

export type CalendarListProps = {
	calendars: CalendarSummary[];
	state: CalendarListState;
	hidden: string[];
	onToggle: (calendarId: string) => void;
	onSettings: (calendar: CalendarSummary) => void;
	onAdd: () => void;
	onRetry: () => void;
};

export type CalendarSettingsDialogProps = {
	/** A calendar to edit, "new" to create one, null when closed. */
	target: CalendarSummary | "new" | null;
	onClose: () => void;
	/** Called after a create, edit or delete so the page reloads its calendars and events. */
	onChanged: (change: "created" | "updated" | "deleted", calendarId: string) => void;
};
