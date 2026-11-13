export type MailSearchContextValue = {
	/** Debounced value lists fetch with. */
	query: string;
	setQuery: (query: string) => void;
};
