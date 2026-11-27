"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getUserTimeZone, parseUserDateTimeLocal } from "@/lib/time/utils";
import { fetchAvailability, type PersonAvailability } from "./availability-api";
import { FIND_DAYS, MAX_FIND_DURATION_MS, MAX_GUESTS, availabilityWindow, findFreeSlots, parseGuestAddresses } from "./availability-utils";
import { AvailabilityView, type FindState } from "./availability-view";

/** The pause after the last keystroke before the server is asked (spec F9 8.6). */
const DEBOUNCE_MS = 400;
const DAY = 86_400_000;

type Answer = { key: string; fromMs: number; ok: boolean; results: Record<string, PersonAvailability> };
type Found = { key: string; at: Date; selfLeftOut?: boolean; state: "loading" | "error" | "ready"; busy: string[][][] };

/**
 * Who is free when the event is: reads the guest field and the event's times, asks `/api/calendar/free-busy` for the event's day
 * and a day either side once typing pauses, and offers "Find a time". A failure never blocks saving; it only shows here.
 */
export function AvailabilityPanel({ guests, rooms = [], startsAt, endsAt, excludeEventId, selfAddress, onPick }: { guests: string; /** Rooms chosen for the event: a row each, and they count in "Find a time". */ rooms?: { id: string; name: string }[]; startsAt: string; endsAt: string; excludeEventId?: string; selfAddress?: string; onPick: (start: Date, end: Date) => void }) {
	const zone = getUserTimeZone();
	const parsedGuests = useMemo(() => parseGuestAddresses(guests), [guests]);
	const roomKey = rooms.map((room) => room.id).join(",");
	const roomIds = useMemo(() => (roomKey ? roomKey.split(",") : []), [roomKey]);
	const roomNames = useMemo(() => new Map(rooms.map((room) => [room.id, room.name])), [rooms]);
	// The server counts people and rooms together against its limit of 50.
	const room = MAX_GUESTS - roomIds.length;
	const parsed = parsedGuests.addresses.slice(0, room);
	const truncated = parsedGuests.truncated || parsedGuests.addresses.length > room;
	const addressKey = parsed.join(",");
	const addresses = useMemo(() => (addressKey ? addressKey.split(",") : []), [addressKey]);
	const start = useMemo(() => parseUserDateTimeLocal(startsAt), [startsAt]);
	const end = useMemo(() => parseUserDateTimeLocal(endsAt), [endsAt]);
	const startMs = start?.getTime() ?? null;
	const window = useMemo(() => (startMs === null ? null : availabilityWindow(new Date(startMs), zone)), [startMs, zone]);
	const fromMs = window?.from.getTime() ?? 0;
	const toMs = window?.to.getTime() ?? 0;
	const [attempt, setAttempt] = useState(0);
	const asked = addresses.length + roomIds.length;
	const requestKey = window && asked ? `${attempt}|${addressKey}|${roomKey}|${fromMs}` : "";
	const [answer, setAnswer] = useState<Answer | null>(null);
	const [found, setFound] = useState<Found | null>(null);
	const finding = useRef(0);

	useEffect(() => {
		if (!requestKey) return;
		let current = true;
		const timer = setTimeout(() => {
			void fetchAvailability(addresses, new Date(fromMs), new Date(toMs), excludeEventId, roomIds).then((result) => {
				if (current) setAnswer({ key: requestKey, fromMs, ok: result.ok, results: result.ok ? result.results : {} });
			});
		}, DEBOUNCE_MS);
		return () => { current = false; clearTimeout(timer); };
	}, [requestKey, addresses, roomIds, fromMs, toMs, excludeEventId]);

	if (!window) return null;
	const settled = answer?.key === requestKey ? answer : null;
	const state = !asked ? "ready" : settled ? (settled.ok ? "ready" : "error") : "loading";
	// While the next answer is awaited the rows of the last one stay (for the same day, whose blocks they still describe), so typing a guest does not blank the list.
	const previous = !settled && answer?.ok && answer.fromMs === fromMs ? answer : null;
	const shown = state === "ready" ? settled : previous;
	const rowFor = (address: string, label?: string) => (state === "ready" ? [{ address, label, availability: settled?.results[address] ?? ({ status: "unknown" } as PersonAvailability) }] : shown?.results[address] ? [{ address, label, availability: shown.results[address] }] : []);
	const rows = state === "error" ? [] : [...addresses.flatMap((address) => rowFor(address)), ...roomIds.flatMap((id) => rowFor(id, roomNames.get(id)))];
	const durationMs = start && end ? end.getTime() - start.getTime() : 0;
	const anyVisible = rows.some((row) => row.availability.status === "ok");
	const findKey = `${addressKey}|${roomKey}`;
	const current = found && found.key === findKey ? found : null;
	const find: FindState = !current ? { state: "idle", slots: [] } : current.state === "ready"
		? { state: "ready", slots: findFreeSlots({ busyByPerson: current.busy, durationMs, now: current.at, zone }) }
		: { state: current.state, slots: [] };

	function onFind() {
		const token = ++finding.current;
		const at = new Date();
		setFound({ key: findKey, at, state: "loading", busy: [] });
		// The organiser's own calendar counts too, though it is not a row: they are asked for last, and never twice.
		const self = selfAddress?.trim().toLowerCase();
		// With the list full there is no room for them: a guest's calendar matters more than the organiser's here, and the view says so.
		const askSelf = !!self && !addresses.includes(self) && asked < MAX_GUESTS;
		const selfLeftOut = !!self && !addresses.includes(self) && !askSelf;
		const askFor = askSelf ? [...addresses, self] : addresses;
		void fetchAvailability(askFor, at, new Date(at.getTime() + (FIND_DAYS + 1) * DAY), excludeEventId, roomIds).then((result) => {
			if (token !== finding.current) return;
			if (!result.ok) { setFound({ key: findKey, at, state: "error", busy: [] }); return; }
			setFound({ key: findKey, at, selfLeftOut, state: "ready", busy: Object.values(result.results).flatMap((person) => (person.status === "ok" ? [person.busy] : [])) });
		});
	}

	return <AvailabilityView zone={zone} guestCount={asked} truncated={truncated} state={state} rows={rows} dayStart={window.dayStart} dayEnd={window.dayEnd} event={{ start, end }}
		find={find} selfLeftOut={current?.state === "ready" && !!current.selfLeftOut} canFind={state === "ready" && anyVisible && durationMs > 0 && durationMs <= MAX_FIND_DURATION_MS} tooLong={durationMs > MAX_FIND_DURATION_MS} onRetry={() => setAttempt((value) => value + 1)} onFind={onFind} onPick={(slot) => onPick(slot.start, slot.end)} />;
}
