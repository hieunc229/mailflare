export type ParsedSearchQuery = {
	/** Free text after operators are removed; matched against every indexed column. */
	text: string;
	from?: string;
	to?: string;
	subject?: string;
	hasAttachment?: boolean;
	read?: "read" | "unread";
	starred?: boolean;
	/** From `category:promotions` (or `promotion`) and `category:primary` (or `inbox`, everything else). */
	category?: "promotions" | "primary";
	/** Inclusive lower bound on the message date, from `after:YYYY-MM-DD`. */
	after?: Date;
	/** Exclusive upper bound on the message date, from `before:YYYY-MM-DD`. */
	before?: Date;
	/** True when anything in the query needs the full-text index. */
	needsFullText: boolean;
};

export type SearchToken = { term: string; negate: boolean; phrase: boolean };
