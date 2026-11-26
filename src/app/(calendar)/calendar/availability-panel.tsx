"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getUserTimeZone, parseUserDateTimeLocal } from "@/lib/time/utils";
import { fetchAvailability, type PersonAvailability } from "./availability-api";
import { FIND_DAYS, MAX_FIND_DURATION_MS, MAX_GUESTS, availabilityWindow, findFreeSlots, parseGuestAddresses } from "./availability-utils";
import { AvailabilityView, type FindState } from "./availability-view";

/** The pause after the last keystroke before the server is asked (spec F9 8.6). */
const DEBOUNCE_MS = 400;
const DAY = 86_400_000;

type Answer = { key: string; ok: boolean; results: Record<string, PersonAvailability> };
type Found = { key: string; at: Date; state: "loading" | "error" | "ready"; busy: string[][][] };

/**
 * Who is free when the event is: reads the guest field and the event's times, asks `/api/calendar/free-busy` for the event's day
 * and a day either side once typing pauses, and offers "Find a time". A failure never blocks saving; it only shows here.
 */
export function AvailabilityPanel({ guests, startsAt, endsAt, excludeEventId, selfAddress, onPick }: { guests: string; startsAt: string; endsAt: string; excludeEventId?: string; selfAddress?: string; onPick: (start: Date, end: Date) => void }) {
	const zone = getUserTimeZone();
	const { addresses: parsed, truncated } = useMemo(() => parseGuestAddresses(guests), [guests]);
	const addressKey = parsed.join(",");
	const addresses = useMemo(() => (addressKey ? addressKey.split(",") : []), [addressKey]);
	const start = useMemo(() => parseUserDateTimeLocal(startsAt), [startsAt]);
	const end = useMemo(() => parseUserDateTimeLocal(endsAt), [endsAt]);
	const startMs = start?.getTime() ?? null;
	const window = useMemo(() => (startMs === null ? null : availabilityWindow(new Date(startMs), zone)), [startMs, zone]);
	const fromMs = window?.from.getTime() ?? 0;
	const toMs = window?.to.getTime() ?? 0;
	const [attempt, setAttempt] = useState(0);
	const requestKey = window && addresses.length ? `${attempt}|${addressKey}|${fromMs}` : "";
	const [answer, setAnswer] = useState<Answer | null>(null);
	const [found, setFound] = useState<Found | null>(null);
	const finding = useRef(0);

	useEffect(() => {
		if (!requestKey) return;
		let current = true;
		const timer = setTimeout(() => {
			void fetchAvailability(addresses, new Date(fromMs), new Date(toMs), excludeEventId).then((result) => {
				if (current) setAnswer({ key: requestKey, ok: result.ok, results: result.ok ? result.results : {} });
			});
		}, DEBOUNCE_MS);
		return () => { current = false; clearTimeout(timer); };
	}, [requestKey, addresses, fromMs, toMs, excludeEventId]);

	if (!window) return null;
	const settled = answer?.key === requestKey ? answer : null;
	const state = !addresses.length ? "ready" : settled ? (settled.ok ? "ready" : "error") : "loading";
	const rows = state === "ready" ? addresses.map((address) => ({ address, availability: settled?.results[address] ?? ({ status: "unknown" } as PersonAvailability) })) : [];
	const durationMs = start && end ? end.getTime() - start.getTime() : 0;
	const anyVisible = rows.some((row) => row.availability.status === "ok");
	const current = found && found.key === addressKey ? found : null;
	const find: FindState = !current ? { state: "idle", slots: [] } : current.state === "ready"
		? { state: "ready", slots: findFreeSlots({ busyByPerson: current.busy, durationMs, now: current.at, zone }) }
		: { state: current.state, slots: [] };

	function onFind() {
		const token = ++finding.current;
		const at = new Date();
		setFound({ key: addressKey, at, state: "loading", busy: [] });
		// The organiser's own calendar counts too, though it is not a row: they are asked for last, and never twice.
		const self = selfAddress?.trim().toLowerCase();
		const askFor = self ? [...addresses.filter((address) => address !== self).slice(0, MAX_GUESTS - 1), self] : addresses;
		void fetchAvailability(askFor, at, new Date(at.getTime() + (FIND_DAYS + 1) * DAY), excludeEventId).then((result) => {
			if (token !== finding.current) return;
			if (!result.ok) { setFound({ key: addressKey, at, state: "error", busy: [] }); return; }
			setFound({ key: addressKey, at, state: "ready", busy: Object.values(result.results).flatMap((person) => (person.status === "ok" ? [person.busy] : [])) });
		});
	}

	return <AvailabilityView zone={zone} guestCount={addresses.length} truncated={truncated} state={state} rows={rows} dayStart={window.dayStart} dayEnd={window.dayEnd} event={{ start, end }}
		find={find} canFind={state === "ready" && anyVisible && durationMs > 0 && durationMs <= MAX_FIND_DURATION_MS} tooLong={durationMs > MAX_FIND_DURATION_MS} onRetry={() => setAttempt((value) => value + 1)} onFind={onFind} onPick={(slot) => onPick(slot.start, slot.end)} />;
}
