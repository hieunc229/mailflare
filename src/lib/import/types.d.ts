export type ImportMailboxResult = {
	imported: number;
	skipped: number;
	errors: string[];
};

export type ImportMessageInput = {
	filename: string;
	raw: ArrayBuffer;
	/** Source read state; when omitted, only outbound mail is imported as read. */
	read?: boolean;
	starred?: boolean;
};
