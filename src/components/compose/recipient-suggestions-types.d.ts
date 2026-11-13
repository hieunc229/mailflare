export type ContactSuggestion = {
	email: string;
	displayName: string | null;
	hasAvatar: boolean;
	blocked: boolean;
};

export type ContactSuggestionsResponse = {
	contacts?: ContactSuggestion[];
	error?: string;
};

export type RecipientSuggestionsProps = {
	id: string;
	mailboxId: string;
	suggestions: ContactSuggestion[];
	activeIndex: number;
	onPick: (suggestion: ContactSuggestion) => void;
	onHover: (index: number) => void;
};
