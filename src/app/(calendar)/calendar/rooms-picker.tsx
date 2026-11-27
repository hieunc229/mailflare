"use client";

import { useId } from "react";
import { AlertCircle, Building2, Check, X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Select } from "@/components/ui/select";
import { formatUserDate } from "@/lib/time/utils";
import type { EventRoom, RoomListState, RoomOption } from "./room-types";
import { MAX_EVENT_ROOMS } from "./room-utils";

const touch = "[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";

export type RoomsPickerProps = {
	/** Every room that exists and is on. */
	rooms: RoomOption[];
	state: RoomListState;
	/** The Team licence: without it a room can be kept or removed, never added. */
	canBook: boolean;
	/** The rooms chosen for this event, in order. */
	selected: string[];
	/** What the server last said of the saved event's rooms, by room id: absent for a room chosen just now. */
	saved: EventRoom[];
	disabled?: boolean;
	/** An occurrence of a series: its rooms are the series', so they are shown and cannot be changed here. */
	readOnly?: boolean;
	onAdd: (id: string) => void;
	onRemove: (id: string) => void;
	onRetry: () => void;
};

/**
 * The editor's room chips (spec F9 8.5). A saved booking says in words whether the room is Booked or Declined, and a declined one
 * names the first date it clashed; colour is never the only signal. Nothing shows when no room exists and none is chosen.
 */
export function RoomsPicker({ rooms, state, canBook, selected, saved, disabled, readOnly, onAdd, onRemove, onRetry }: RoomsPickerProps) {
	const { t } = useLanguage();
	const labelId = useId();
	const noteId = useId();
	const byId = new Map(rooms.map((room) => [room.id, room]));
	const offered = rooms.filter((room) => !selected.includes(room.id));
	const full = selected.length >= MAX_EVENT_ROOMS;
	// A room turned off or deleted since it was booked is still shown, by what is left of it.
	const chips = selected.map((id) => ({ id, room: byId.get(id), booking: saved.find((item) => item.resourceId === id) }));
	if (state === "ready" && !rooms.length && !selected.length) return null;
	return (
		<div className="min-w-0 space-y-2" role="group" aria-labelledby={labelId}>
			<span id={labelId} className="sr-only">{t("calendar.rooms.title")}</span>
			{state === "error" && (
				<div role="alert" className="flex flex-wrap items-center gap-2 px-2 text-sm text-red-700">
					<AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
					<span className="min-w-0 flex-1">{t("calendar.rooms.loadFailed")}</span>
					<button type="button" onClick={onRetry} className={`rounded-md px-2 font-medium text-blue-700 underline hover:bg-blue-50 ${focus} ${touch}`}>{t("calendar.rooms.retry")}</button>
				</div>
			)}
			{chips.length > 0 && (
				<ul className="flex flex-wrap gap-2 px-2">
					{chips.map(({ id, room, booking }) => {
						const name = room?.name ?? t("calendar.rooms.removedRoom");
						const declined = booking?.status === "declined";
						const status = !booking ? "" : declined
							? booking.conflictAt ? t("calendar.rooms.declinedOn", { date: formatUserDate(new Date(booking.conflictAt), { dateStyle: "medium" }) }) : t("calendar.rooms.declined")
							: t("calendar.rooms.booked");
						return (
							<li key={id} className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-full border py-1 pl-3 pr-1 text-sm ${declined ? "border-red-300 bg-red-50 text-red-800" : "border-neutral-200 bg-neutral-50 text-neutral-800"}`}>
								{declined ? <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" /> : booking ? <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-green-700" /> : <Building2 aria-hidden="true" className="h-4 w-4 shrink-0 text-neutral-600" />}
								<span className="min-w-0"><span className="block truncate font-medium">{name}</span>{status && <span className="block truncate text-xs">{status}</span>}</span>
								{!readOnly && <button type="button" disabled={disabled} onClick={() => onRemove(id)} aria-label={t("calendar.rooms.remove", { name })} className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-neutral-200 disabled:opacity-50 ${focus} ${touch}`}><X aria-hidden="true" className="h-4 w-4" /></button>}
							</li>
						);
					})}
				</ul>
			)}
			{state === "loading" && !chips.length && <p role="status" className="px-2 text-sm text-neutral-600">{t("calendar.rooms.loading")}</p>}
			{state === "ready" && !readOnly && offered.length > 0 && (
				<div className="relative min-w-0">
					<Select value="" containerClassName="contents" disabled={disabled || !canBook || full} aria-label={t("calendar.rooms.add")} aria-describedby={!canBook || full ? noteId : undefined}
						onChange={(event) => { if (event.target.value) onAdd(event.target.value); }}
						className={`h-9 rounded-md border border-transparent pl-2 pr-2 text-sm text-neutral-700 hover:bg-neutral-50 focus-visible:border-blue-600 focus-visible:bg-white ${touch}`}>
						<option value="">{t("calendar.rooms.add")}</option>
						{offered.map((room) => <option key={room.id} value={room.id}>{[room.name, room.capacity !== null ? t("calendar.rooms.seats", { count: room.capacity }) : "", room.location].filter(Boolean).join(" · ")}</option>)}
					</Select>
				</div>
			)}
			{readOnly && selected.length > 0 && <p className="px-2 text-xs text-neutral-600">{t("calendar.rooms.seriesNote")}</p>}
			{state === "ready" && !readOnly && (!canBook || full) && <p id={noteId} className="px-2 text-xs text-neutral-600">{full ? t("calendar.rooms.limit", { count: MAX_EVENT_ROOMS }) : t("calendar.rooms.needsTeam")}</p>}
		</div>
	);
}
