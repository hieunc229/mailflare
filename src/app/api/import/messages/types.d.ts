export type ImportMessagesResponse = {
	imported?: number;
	skipped?: number;
	errors?: string[];
	/** Messages in the upload beyond the per-request limit that were not imported. */
	truncated?: number;
	error?: string;
};
