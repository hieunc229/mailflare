"use client";

import { AlertCircle, Building2, Pencil, Plus, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { mobilePrimaryActionClass } from "@/components/page-header-utils";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { List, ListRow } from "@/components/ui/list";
import { Switch } from "@/components/ui/switch";
import type { Room } from "./types";

const touch = "[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";

export type RoomsViewProps = {
	state: "loading" | "error" | "ready";
	rooms: Room[];
	/** The Team licence is in force: without it nothing new can be added. */
	available: boolean;
	/** Translated reason the last delete failed, or "". */
	notice: string;
	deleting: boolean;
	onAdd: () => void;
	onEdit: (room: Room) => void;
	onDelete: (room: Room) => void;
	onRetry: () => void;
	/** Turns a room's public booking switch on or off; when absent the switch is not drawn. */
	onPublicBooking?: (room: Room, value: boolean) => void;
};

/** Presentation only: the page owns the requests, so every state can be rendered on its own. */
export function RoomsView({ state, rooms, available, notice, deleting, onAdd, onEdit, onDelete, onRetry, onPublicBooking }: RoomsViewProps) {
	const { t } = useLanguage();
	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between gap-4">
				<h1 className="text-2xl font-medium md:text-3xl">{t("rooms.title")}</h1>
				<Button className={mobilePrimaryActionClass} disabled={state !== "ready" || !available} onClick={onAdd}><Plus className="h-4 w-4" />{t("rooms.add")}</Button>
			</div>
			<p className="text-sm text-neutral-600">{t("rooms.intro")}</p>
			{state === "ready" && !available && <p className="text-sm text-amber-700">{t("rooms.needsTeam")}</p>}
			{notice && <p role="alert" className="text-sm text-red-700">{notice}</p>}
			<section className="space-y-3" aria-busy={state === "loading"}>
				{state === "loading" && <SectionRowSkeleton />}
				{state === "error" && (
					<div role="alert" className="flex flex-wrap items-center gap-2 rounded-2xl bg-white px-5 py-4 text-sm text-red-700">
						<AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
						<span className="min-w-0 flex-1">{t("rooms.loadFailed")}</span>
						<Button type="button" variant="outline" size="sm" onClick={onRetry}>{t("rooms.retry")}</Button>
					</div>
				)}
				{state === "ready" && rooms.length === 0 && (
					<div className="rounded-2xl bg-white px-5 py-6 text-sm">
						<p className="font-medium text-neutral-900">{t("rooms.empty")}</p>
						<p className="mt-1 text-neutral-600">{t("rooms.emptyHint")}</p>
					</div>
				)}
				{state === "ready" && rooms.length > 0 && (
					<List>
						{rooms.map((room) => (
							<ListRow key={room.id} className="flex-wrap gap-y-2 px-4 py-4 sm:flex-nowrap sm:px-5">
								<span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700"><Building2 className="h-5 w-5" /></span>
								<span className="min-w-0 flex-1 space-y-1">
									<span className="flex min-w-0 flex-wrap items-center gap-2">
										<strong className="truncate text-sm font-semibold text-neutral-900">{room.name}</strong>
										<Badge variant="outline">{t(room.kind === "room" ? "rooms.kind.room" : "rooms.kind.equipment")}</Badge>
										{room.disabled && <Badge variant="outline">{t("rooms.disabled")}</Badge>}
										{room.publicBooking && <Badge variant="outline">{t("rooms.publicBookingBadge")}</Badge>}
									</span>
									<span className="block truncate text-sm text-neutral-600">{[room.location, room.capacity !== null ? t("rooms.capacityValue", { count: room.capacity }) : ""].filter(Boolean).join(" · ")}</span>
								</span>
								<span className="ml-auto flex shrink-0 items-center gap-2">
									{onPublicBooking && <Switch checked={room.publicBooking === true} disabled={!available && room.publicBooking !== true} onCheckedChange={(value) => onPublicBooking(room, value)} aria-label={t("rooms.publicBooking") + ": " + room.name} />}
									<Button type="button" size="sm" variant="outline" className={touch} aria-label={t("rooms.edit", { name: room.name })} onClick={() => onEdit(room)}><Pencil className="h-4 w-4" /></Button>
									<Button type="button" size="sm" variant="outline" className={touch} aria-label={t("rooms.delete", { name: room.name })} disabled={deleting} onClick={() => onDelete(room)}><Trash2 className="h-4 w-4" /></Button>
								</span>
							</ListRow>
						))}
					</List>
				)}
			</section>
		</div>
	);
}
