export type ResourceKind = "room" | "equipment";

export type ResourceSummary = {
	id: string;
	name: string;
	kind: ResourceKind;
	capacity: number | null;
	location: string;
	description: string;
	disabled: boolean;
};

export type ResourceFailure = { ok: false; status: 400 | 403 | 404 | 409; error: string; code?: "NAME_TAKEN" | "RESOURCE_LIMIT" | "HAS_BOOKINGS" | "TEAM_REQUIRED" | "ROOM_UNKNOWN" | "TOO_MANY_ROOMS" };
export type ResourceResult = { ok: true; resource: ResourceSummary } | ResourceFailure;
export type ResourceDeleteResult = { ok: true; name: string; eventIds: string[]; bookings: number } | (ResourceFailure & { bookings?: number; /** The count stopped at the most that is reported: there are more. */ capped?: boolean });
export type BookableRooms = { ok: true; ids: string[] } | ResourceFailure;
