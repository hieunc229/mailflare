/** One sender as the Subscriptions API returns it (dates are ISO strings on the wire). */
export type SubscriptionRowData = {
	senderAddress: string;
	displayName: string;
	total: number;
	lastReceived: string;
	readRate: number;
	latestMessageId: string | null;
	canUnsubscribe: boolean;
	categoryOverride: "inbox" | "promotions" | null;
	unsubscribedAt: string | null;
	stillSending: boolean;
};

export type SubscriptionCategory = "auto" | "inbox" | "promotions";
export type SubscriptionRowAction = "unsubscribe" | "unsubscribeTrash" | "block" | "trash";
export type SubscriptionTrashAction = "trash" | "unsubscribeTrash";
export type TrashPreview = { count: number; willChange: number; olderLeft: number };

export type SubscriptionRowView = {
	canChange: boolean;
	category: SubscriptionCategory;
	stillSending: boolean;
	unsubscribedOn: string | null;
	actions: SubscriptionRowAction[];
};
