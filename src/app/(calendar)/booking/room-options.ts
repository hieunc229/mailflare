import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { BookingRoomOption } from "./room-problem";

export type BookingRoomStore = { rooms: BookingRoomOption[]; canBook: boolean; state: "loading" | "error" | "ready" };

/** The rooms an owner may attach, with what each can be used for (`/api/booking/rooms`). Loaded once per page. */
export function useBookingRooms(): { store: BookingRoomStore; retry: () => void } {
	const [store, setStore] = useState<BookingRoomStore>({ rooms: [], canBook: false, state: "loading" });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let active = true;
		void authFetch("/api/booking/rooms", { cache: "no-store" }).then(async (response) => {
			if (!response.ok) throw new Error();
			const data = await response.json() as { rooms?: BookingRoomOption[]; canBook?: boolean };
			if (active) setStore({ rooms: data.rooms ?? [], canBook: data.canBook === true, state: "ready" });
		}).catch(() => { if (active) setStore((current) => ({ ...current, state: current.rooms.length ? "ready" : "error" })); });
		return () => { active = false; };
	}, [attempt]);
	return { store, retry: () => { setStore((current) => ({ ...current, state: "loading" })); setAttempt((value) => value + 1); } };
}
