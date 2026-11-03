export type MessageNavigationEntry = {
	id: string;
	unread: boolean;
};

export type MessageNavigationResponse = {
	messages: MessageNavigationEntry[];
	/** The window stopped before the folder's ends, so the buttons can move further. */
	hasNewer?: boolean;
	hasOlder?: boolean;
};
