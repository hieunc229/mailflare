import type { BookingRoomStore } from "./room-options";
import type { BookingForm, BookingHost } from "./types";

export type BookingEditorProps = {
	form: BookingForm;
	open: boolean;
	editingId: string | null;
	username: string;
	hosts: BookingHost[];
	canManageHosts: boolean;
	/** The shared rooms store (Team): the section shows only when a room exists or one is chosen. */
	roomStore: BookingRoomStore;
	onRetryRooms: () => void;
	currentUserId: string;
	saving: boolean;
	onChange: (form: BookingForm) => void;
	onClose: () => void;
	onSave: () => void;
	onDelete: () => void;
	onToggleEnabled: () => void;
	onClosed: () => void;
};
