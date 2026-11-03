export type MessageNavigationEntry = {
	id: string;
	unread: boolean;
};

export type MessageNavigationResponse = {
	messages: MessageNavigationEntry[];
	hasNewer?: boolean;
	hasOlder?: boolean;
};
