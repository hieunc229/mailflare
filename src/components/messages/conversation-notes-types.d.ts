import type { ThreadMessage } from "@/hooks/types";
import type { ConversationNote } from "@/lib/notes/types";

export type UseConversationNotesResult = {
	notes: ConversationNote[];
	loading: boolean;
	/** Appends a note; rejects when it could not be saved. */
	add: (body: string, attachedMessageId?: string | null) => Promise<void>;
	/** Rewrites one of your notes; rejects when it could not be saved. */
	update: (noteId: string, body: string) => Promise<void>;
	/** Deletes one of your notes; rejects when it could not be removed. */
	remove: (noteId: string) => Promise<void>;
};

export type ConversationNotesPanelProps = {
	/** Any message of the conversation; notes are anchored to its thread. */
	messageId: string;
	notes: ConversationNote[];
	loading: boolean;
	onAdd: (body: string, attachedMessageId?: string | null) => Promise<void>;
	/** Emails of the conversation, to show the ones notes are attached to. */
	threadMessages: ThreadMessage[];
	mailboxId: string | null;
	currentAccountName?: string;
	/** The email the next note will be attached to, chosen from an email's menu. */
	attachmentId: string | null;
	onAttachmentChange: (messageId: string | null) => void;
	onUpdate: (noteId: string, body: string) => Promise<void>;
	onRemove: (noteId: string) => Promise<void>;
	onClose: () => void;
	className?: string;
};

export type ConversationNoteItemProps = {
	messageId: string;
	attachedMessage: ThreadMessage | null;
	mailboxId: string | null;
	currentAccountName?: string;
	note: ConversationNote;
	/** Only the author can edit or delete a note. */
	canModify: boolean;
	onUpdate: (noteId: string, body: string) => Promise<void>;
	onRemove: (noteId: string) => Promise<void>;
};

export type ConversationNoteEmailProps = {
	/** The attached email; null when it is no longer in the conversation. */
	message: ThreadMessage | null;
	mailboxId: string | null;
	currentAccountName?: string;
	/** Shown on the draft note only, to detach the email before sending. */
	onRemove?: () => void;
	className?: string;
};
