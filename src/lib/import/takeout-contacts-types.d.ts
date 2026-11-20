import type { TranslationKey } from "../i18n/types";
import type { ContactImportSummary } from "../contacts/import-store-types";

export type ContactRunSettings = {
	mailboxId: string;
	/** Upload the photos of vCard cards. */
	photos: boolean;
};

/** A reason shown to the user: a catalog key with its values (translated where it is shown), or text from the server. */
export type ContactRunNotice = string | { key: TranslationKey; params?: Record<string, string | number> };

export type ContactRunSummary = {
	/** Contacts (cards or rows) in the file. */
	cards: number;
	/** With at least one valid address; only these are sent. */
	withEmail: number;
	noEmail: number;
	/** The first few names of cards without an address. */
	noEmailNames: string[];
	created: number;
	updated: number;
	unchanged: number;
	/** Cards the server could not take, even alone. */
	failed: number;
	/** The first few reasons something was not imported. */
	errors: ContactRunNotice[];
	photosUploaded: number;
	photosFailed: number;
	aborted: boolean;
	/** The server kept answering 429: the rest of the file was not sent. */
	rateLimited: boolean;
};

export type ContactPostResult = {
	status: number;
	/** From a 429's Retry-After header, in milliseconds. */
	retryAfterMs?: number;
	data: Partial<ContactImportSummary> & { error?: string };
};

export type ContactPost = (body: unknown, signal?: AbortSignal) => Promise<ContactPostResult>;

export type ContactRunOptions = {
	signal?: AbortSignal;
	/** Contacts done and total. */
	onProgress?: (done: number, total: number) => void;
	/** Waits before a retry; stops early when the signal aborts. Tests pass a fake. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** Uploads one contact's picture. Throws with a reason when the server refuses it. */
export type ContactPhotoUpload = (address: string, photo: File) => Promise<void>;
