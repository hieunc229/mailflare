import { useEffect, useSyncExternalStore } from "react";
import { authFetch } from "@/lib/auth/client";
import type { RoomListState, RoomOption } from "./room-types";
import { readShownRooms, toggleShownRoom, writeShownRooms } from "./room-utils";

/**
 * The rooms list is shown in the sidebar, the mobile drawer and the event editor, so they share one store (as the calendar list does)
 * instead of each fetching it and keeping which schedules are on.
 */
export type RoomSnapshot = {
	rooms: RoomOption[];
	/** The Team licence is in force: without it rooms can be seen but not newly booked. */
	canBook: boolean;
	state: RoomListState;
	/** Rooms whose schedules are drawn on the calendar, in this browser. */
	shown: string[];
};

const initial: RoomSnapshot = { rooms: [], canBook: false, state: "loading", shown: [] };
let snapshot = initial;
let started = false;
const listeners = new Set<() => void>();

function set(patch: Partial<RoomSnapshot>) {
	snapshot = { ...snapshot, ...patch };
	for (const listener of listeners) listener();
}

export const getRoomSnapshot = () => snapshot;
export function subscribeRooms(listener: () => void) {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/** Fetches the list. A refresh that fails keeps what is on screen; only the first load can end in the error state. */
export async function reloadRooms(): Promise<void> {
	try {
		const response = await authFetch("/api/calendar/resources");
		if (!response.ok) throw new Error();
		const data = await response.json() as { resources?: RoomOption[]; canBook?: boolean };
		set({ rooms: data.resources ?? [], canBook: data.canBook === true, state: "ready" });
	} catch {
		set({ state: snapshot.rooms.length ? "ready" : "error" });
	}
}

export function startRoomState() {
	if (started) return;
	started = true;
	set({ shown: readShownRooms() });
	void reloadRooms();
}

export function retryRooms() {
	set({ state: "loading" });
	void reloadRooms();
}

export function toggleRoom(id: string) {
	const shown = toggleShownRoom(snapshot.shown, id);
	writeShownRooms(shown);
	set({ shown });
}

/** For tests. */
export function resetRoomState() {
	started = false;
	snapshot = initial;
	listeners.clear();
}

export function useRoomState(): RoomSnapshot {
	useEffect(() => { startRoomState(); }, []);
	return useSyncExternalStore(subscribeRooms, getRoomSnapshot, () => initial);
}
