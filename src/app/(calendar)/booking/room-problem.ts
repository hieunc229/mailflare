export type BookingRoomState = "available" | "off" | "private";
export type BookingRoomOption = { id: string; name: string; kind: "room" | "equipment"; capacity: number | null; location: string; state: BookingRoomState };
export type BookingRoomProblem = "off" | "private" | "licence";

/**
 * Why a booking type with these rooms offers visitors no times, or null when nothing is wrong (or nothing is known yet: while the list loads or failed,
 * a room is not called deleted). Gone and turned-off rooms first, then rooms closed to public pages, then the Team licence: the public page fails closed on all three.
 */
export function bookingRoomsProblem(ids: string[], rooms: { id: string; state: BookingRoomState }[], canBook: boolean, state: "loading" | "error" | "ready" | string): BookingRoomProblem | null {
	if (state !== "ready" || !ids.length) return null;
	const byId = new Map(rooms.map((room) => [room.id, room.state]));
	if (ids.some((id) => (byId.get(id) ?? "off") === "off")) return "off";
	if (ids.some((id) => byId.get(id) === "private")) return "private";
	return canBook ? null : "licence";
}
