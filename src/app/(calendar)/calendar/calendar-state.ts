import { useEffect, useSyncExternalStore } from "react";
import { authFetch } from "@/lib/auth/client";
import type { CalendarSummary } from "@/lib/calendar/calendars-types";
import type { CalendarListState } from "./calendar-list-types";
import { readHiddenCalendars, toggleHidden, writeHiddenCalendars } from "./calendar-list-utils";

/**
 * The calendar list is shown in several places at once (the sidebar, the mobile drawer, the options dialog, the editor's picker),
 * and the settings dialog is opened from any of them, so they share one store instead of each fetching and keeping hidden ids.
 */
export type CalendarSnapshot = {
	calendars: CalendarSummary[];
	state: CalendarListState;
	/** Calendar ids hidden in this browser. */
	hidden: string[];
	/** The calendar being edited, "new" while creating one, null when the dialog is closed. */
	settings: CalendarSummary | "new" | null;
	/** Bumped after a create, edit or delete: event lists refetch when it changes. */
	revision: number;
};

const initial: CalendarSnapshot = { calendars: [], state: "loading", hidden: [], settings: null, revision: 0 };
let snapshot = initial;
let started = false;
const listeners = new Set<() => void>();

function set(patch: Partial<CalendarSnapshot>) {
	snapshot = { ...snapshot, ...patch };
	for (const listener of listeners) listener();
}

export const getCalendarSnapshot = () => snapshot;
export function subscribeCalendars(listener: () => void) {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/** Fetches the list. A refresh that fails keeps what is on screen; only the first load can end in the error state. */
export async function reloadCalendars(): Promise<void> {
	try {
		const response = await authFetch("/api/calendar/calendars");
		if (!response.ok) throw new Error();
		const data = await response.json() as { calendars?: CalendarSummary[] };
		set({ calendars: data.calendars ?? [], state: "ready" });
	} catch {
		set({ state: snapshot.calendars.length ? "ready" : "error" });
	}
}

export function startCalendarState() {
	if (started) return;
	started = true;
	set({ hidden: readHiddenCalendars() });
	void reloadCalendars();
}

export function retryCalendars() {
	set({ state: "loading" });
	void reloadCalendars();
}

export function toggleCalendar(id: string) {
	const hidden = toggleHidden(snapshot.hidden, id);
	writeHiddenCalendars(hidden);
	set({ hidden });
}

export const openCalendarSettings = (target: CalendarSummary | "new") => set({ settings: target });
export const closeCalendarSettings = () => set({ settings: null });

export function calendarChanged(change: "created" | "updated" | "deleted", id: string) {
	let hidden = snapshot.hidden;
	if (change === "deleted" && hidden.includes(id)) { hidden = hidden.filter((item) => item !== id); writeHiddenCalendars(hidden); }
	set({ settings: null, hidden, revision: snapshot.revision + 1 });
	void reloadCalendars();
}

/** For tests. */
export function resetCalendarState() {
	started = false;
	snapshot = initial;
	listeners.clear();
}

export function useCalendarState(): CalendarSnapshot {
	useEffect(() => { startCalendarState(); }, []);
	return useSyncExternalStore(subscribeCalendars, getCalendarSnapshot, () => initial);
}
