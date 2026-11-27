"use client";

import { useId } from "react";
import { useLanguage } from "@/components/language-provider";
import { toggleRoom, useRoomState } from "./room-state";
import type { RoomListState, RoomOption } from "./room-types";

const touch = "[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";

export type RoomListViewProps = { rooms: RoomOption[]; state: RoomListState; shown: string[]; onToggle: (id: string) => void };

/**
 * Presentation only. The section appears once the list has loaded and has rooms: an installation without rooms never sees it, not
 * even while loading, and a list that failed to load is not announced here (the editor's picker, which needs it, says so).
 */
export function RoomListView({ rooms, state, shown, onToggle }: RoomListViewProps) {
	const { t } = useLanguage();
	const titleId = useId();
	if (state !== "ready" || !rooms.length) return null;
	return (
		<section aria-labelledby={titleId} className="mb-6 border-b border-neutral-100 pb-4">
			<h2 id={titleId} className="mb-1 text-sm font-semibold text-neutral-900">{t("calendar.rooms.sidebarTitle")}</h2>
			<ul className="space-y-0.5">
				{rooms.map((room) => (
					<li key={room.id}>
						<label className={`flex min-w-0 cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 text-sm text-neutral-800 hover:bg-neutral-50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-blue-600 ${touch}`}>
							<input type="checkbox" checked={shown.includes(room.id)} onChange={() => onToggle(room.id)} aria-label={t("calendar.rooms.show", { name: room.name })} style={{ accentColor: "#0d9488" }} className="h-4 w-4 shrink-0 cursor-pointer [@media(pointer:coarse)]:h-5 [@media(pointer:coarse)]:w-5" />
							<span className="min-w-0 flex-1"><span className="block truncate">{room.name}</span>{room.location && <span className="block truncate text-xs text-neutral-600">{room.location}</span>}</span>
						</label>
					</li>
				))}
			</ul>
		</section>
	);
}

/** The "Rooms" section under the calendars: a show/hide checkbox per room, read from the shared store so every copy on screen stays in step. */
export function RoomList() {
	const { rooms, state, shown } = useRoomState();
	return <RoomListView rooms={rooms} state={state} shown={shown} onToggle={toggleRoom} />;
}
