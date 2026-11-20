import type { ContactDetailsData } from "./details-types";

/** One card of a vCard or Google CSV file, before validation. Addresses are raw text, primary first. */
export type ImportedContact = {
	name: string | null;
	emails: string[];
	details: Omit<ContactDetailsData, "emails">;
};

/** A PHOTO property. A URI is never fetched; inline data is checked and decoded in the browser only. */
export type ContactPhoto = { kind: "inline"; base64: string } | { kind: "uri" };

export type SplitVcard = {
	/** The card's unfolded lines, without PHOTO, LOGO, SOUND and KEY. */
	text: string;
	photo: ContactPhoto | null;
};

export type SplitVcardsResult = {
	cards: SplitVcard[];
	/** Cards over the size cap, left out. */
	tooLarge: number;
	/** The file held more than MAX_VCARDS cards; the rest were not read. */
	truncated: boolean;
};
