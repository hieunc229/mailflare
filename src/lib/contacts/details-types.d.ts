/** What a contact import keeps beyond name and address. Stored as JSON in `contact_details`. */
export type ContactDetailsData = {
	/** Every address on the source card (at most 20), so each row can show "also: ...". */
	emails?: string[];
	phones?: { type: string; value: string }[];
	addresses?: { type: string; formatted: string }[];
	organization?: string;
	title?: string;
	/** YYYY-MM-DD, or --MM-DD when the year is unknown. */
	birthday?: string;
	note?: string;
};
