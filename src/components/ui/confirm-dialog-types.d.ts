export type ConfirmOptions = {
	message: string;
	title?: string;
	/** Defaults to the translated "Continue". */
	confirmLabel?: string;
	/** Styles the confirm button red, for deletes and other irreversible actions. */
	destructive?: boolean;
	/** The user must type this exact text (case-insensitive) before confirming, e.g. a hostname. */
	requireText?: string;
};

export type ConfirmRequest = {
	kind: "confirm" | "alert";
	options: ConfirmOptions;
	resolve: (confirmed: boolean) => void;
};
