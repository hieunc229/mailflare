import type { Room, RoomForm } from "./types";

export const MAX_CAPACITY = 100_000;
export const NEW_ROOM_FORM: RoomForm = { name: "", kind: "room", capacity: "", location: "", description: "", disabled: false };

export const formFromRoom = (room: Room): RoomForm => ({ name: room.name, kind: room.kind, capacity: room.capacity === null ? "" : String(room.capacity), location: room.location, description: room.description, disabled: room.disabled });

/** The capacity field as the API takes it: empty is "not set" (null), otherwise a whole number from 1 to 100000; anything else is undefined. */
export function parseCapacity(text: string): number | null | undefined {
	const value = text.trim();
	if (!value) return null;
	if (!/^\d{1,6}$/.test(value)) return undefined;
	const number = Number(value);
	return number >= 1 && number <= MAX_CAPACITY ? number : undefined;
}

/** The body of a create or edit request, or null while the form is not acceptable (the button stays disabled). */
export function roomBody(form: RoomForm): Omit<Room, "id"> | null {
	const name = form.name.trim();
	const capacity = parseCapacity(form.capacity);
	return name && name.length <= 120 && capacity !== undefined ? { name, kind: form.kind, capacity, location: form.location.trim(), description: form.description.trim(), disabled: form.disabled } : null;
}

/** The translation key for a refused request, chosen from the status and code so the server's English text is never shown. */
export function roomErrorKey(action: "save" | "delete", status: number, code?: string): string {
	if (status === 404) return "rooms.error.notFound";
	if (code === "NAME_TAKEN") return "rooms.error.nameTaken";
	if (code === "RESOURCE_LIMIT") return "rooms.error.limit";
	if (code === "TEAM_REQUIRED") return "rooms.error.team";
	if (status === 400) return "rooms.error.invalid";
	return action === "save" ? "rooms.saveFailed" : "rooms.deleteFailed";
}
