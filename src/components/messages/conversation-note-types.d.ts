import type { ConversationNote } from "@/lib/notes/types";

export type ConversationNoteProps = {
	/** Any message of the conversation; the note is anchored to its thread key. */
	messageId: string;
	className?: string;
};

export type UseConversationNoteResult = {
	note: ConversationNote | null;
	loading: boolean;
	/** Persists the note; an empty body removes it. Rejects when the save fails. */
	save: (html: string) => Promise<void>;
};
