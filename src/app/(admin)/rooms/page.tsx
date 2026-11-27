"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { authFetch } from "@/lib/auth/client";
import { RoomDialog } from "./room-dialog";
import { RoomsView } from "./rooms-view";
import type { Room } from "./types";
import { roomErrorKey } from "./utils";

type Answer = { resources: Room[]; available: boolean };
class RoomsError extends Error { constructor(readonly key: string, readonly status = 0, readonly code?: string, readonly bookings?: number) { super(key); } }

async function send(method: "POST" | "PATCH" | "DELETE", body: unknown, action: "save" | "delete") {
	let response: Response;
	try { response = await authFetch("/api/admin/calendar-resources", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); } catch { throw new RoomsError(roomErrorKey(action, 0)); }
	if (response.ok) return;
	const data = (await response.json().catch(() => ({}))) as { code?: string; bookings?: number };
	throw new RoomsError(roomErrorKey(action, response.status, data.code), response.status, data.code, data.bookings);
}

/** Admin: the rooms and equipment people can book (spec F9 8.7). Adding needs a Team licence; everything else stays possible after one lapses. */
export default function RoomsPage() {
	const { t } = useLanguage();
	const client = useQueryClient();
	const [target, setTarget] = useState<Room | "new" | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const { data, isLoading, isError, refetch } = useQuery({
		queryKey: ["admin-calendar-resources"],
		queryFn: async () => {
			const response = await authFetch("/api/admin/calendar-resources", { cache: "no-store" });
			if (!response.ok) throw new Error("load");
			return (await response.json()) as Answer;
		},
	});
	const refresh = () => client.invalidateQueries({ queryKey: ["admin-calendar-resources"] });
	const save = useMutation({
		mutationFn: ({ body, id }: { body: Omit<Room, "id">; id: string | null }) => send(id ? "PATCH" : "POST", id ? { id, ...body } : body, "save"),
		onSuccess: () => { setTarget(null); setError(""); void refresh(); },
		onError: (failure) => setError(t((failure instanceof RoomsError ? failure.key : "rooms.saveFailed") as never)),
	});
	const remove = useMutation({
		mutationFn: async (room: Room) => {
			if (!(await confirmDestructive(t("rooms.deleteConfirm", { name: room.name })))) return;
			try { await send("DELETE", { id: room.id }, "delete"); } catch (failure) {
				// Events still have it booked ahead: say how many and ask again before dropping those bookings.
				if (!(failure instanceof RoomsError) || failure.code !== "HAS_BOOKINGS") throw failure;
				if (!(await confirmDestructive(t("rooms.deleteBooked", { count: failure.bookings ?? 0, name: room.name })))) return;
				await send("DELETE", { id: room.id, force: true }, "delete");
			}
		},
		onSuccess: () => { setNotice(""); void refresh(); },
		onError: (failure) => setNotice(t((failure instanceof RoomsError ? failure.key : "rooms.deleteFailed") as never)),
	});
	return (
		<>
			<RoomsView state={isLoading ? "loading" : isError ? "error" : "ready"} rooms={data?.resources ?? []} available={data?.available ?? false} notice={notice} deleting={remove.isPending}
				onAdd={() => { setError(""); setTarget("new"); }} onEdit={(room) => { setError(""); setTarget(room); }} onDelete={(room) => remove.mutate(room)} onRetry={() => void refetch()} />
			<RoomDialog target={target} saving={save.isPending} error={error} onClose={() => setTarget(null)} onSave={(body, id) => save.mutate({ body, id })} />
		</>
	);
}
