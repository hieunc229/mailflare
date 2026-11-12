import type { ReactNode } from "react";
import type { ConversationNote } from "@/lib/notes/types";

/** An email of the open conversation, named on the notes that are about it. */
export type NoteEmail = {
	id: string;
	sender: string;
	/** The recipients of an outbound email, named on the chip instead of the sender. */
	recipient?: string;
	createdAt: string;
};

export type ConversationNotesProviderProps = {
	/** Any message of the conversation; the notes are those of its thread. */
	messageId: string;
	/** The emails of the conversation that are on screen. */
	emails: NoteEmail[];
	children: ReactNode;
};

export type ConversationNotesState = {
	notes: ConversationNote[];
	/** The email the notes were looked up from; avatars are served relative to it. */
	messageId: string;
	loading: boolean;
	/** Whether the notes are shown in full, with the box to write one. */
	open: boolean;
	setOpen: (open: boolean) => void;
	/** The email the next note will be about; null for the whole conversation. */
	attachTo: string | null;
	setAttachTo: (messageId: string | null) => void;
	/** Opens the notes and puts the cursor in the box, for a note about `messageId` when given. */
	startNote: (messageId?: string) => void;
	/** Goes up each time `startNote` asks the box to take focus. */
	focusRequest: number;
	/** Marks the focus request handled so reopening the panel does not focus again. */
	focusHandled: () => void;
	/** Text of the note being written; lives here so collapsing the panel keeps it. */
	draft: string;
	setDraft: (draft: string) => void;
	/** True while `add` is saving. */
	adding: boolean;
	/** Text of each note being edited, by note id; a key means that note is in edit mode. */
	editDrafts: Record<string, string>;
	/** Pass null to leave edit mode without saving. */
	setEditDraft: (noteId: string, html: string | null) => void;
	email: (messageId: string) => NoteEmail | undefined;
	/** Each of these rejects when the server refuses or cannot be reached. */
	add: (html: string) => Promise<void>;
	update: (noteId: string, html: string) => Promise<void>;
	remove: (noteId: string) => Promise<void>;
};

export type ConversationNotesProps = {
	className?: string;
};
