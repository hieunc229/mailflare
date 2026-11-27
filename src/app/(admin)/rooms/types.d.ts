export type Room = {
	id: string;
	name: string;
	kind: "room" | "equipment";
	capacity: number | null;
	location: string;
	description: string;
	disabled: boolean;
	/** Open to public booking pages (Team, off by default). Changed with its own switch, not the dialog. */
	publicBooking?: boolean;
};

export type RoomForm = { name: string; kind: Room["kind"]; capacity: string; location: string; description: string; disabled: boolean };
