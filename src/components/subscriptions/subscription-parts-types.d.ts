import type { SubscriptionCategory, SubscriptionRowAction, SubscriptionRowData, SubscriptionRowView } from "@/lib/promotions/subscriptions-ui-types";

export type SubscriptionRowProps = {
	row: SubscriptionRowData;
	view: SubscriptionRowView;
	/** One request at a time: every control is disabled while any row works. */
	busy: boolean;
	/** `returnFocus` puts focus back on the control once the change is over (the control is disabled while it runs). */
	onCategory: (category: SubscriptionCategory, returnFocus?: () => void) => void;
	onAction: (action: SubscriptionRowAction, returnFocus: () => void) => void;
};
