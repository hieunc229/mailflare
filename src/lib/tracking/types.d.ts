export type OpenRequestInfo = {
	userAgent: string | null;
	asn?: number;
	country?: string | null;
	city?: string | null;
	sentAt: Date;
	openedAt: Date;
};

export type OpenClassification = {
	client: string | null;
	device: string | null;
	country: string | null;
	city: string | null;
	/** Prefetches by privacy proxies and security scanners, not a person reading. */
	automated: boolean;
};

export type MessageOpenEvent = OpenClassification & { openedAt: string };

export type MessageTrackingSummary = {
	openCount: number;
	firstOpenedAt: string | null;
	lastOpenedAt: string | null;
	/** True when the only fetches so far were automated, e.g. Apple Mail Privacy Protection. */
	onlyAutomated: boolean;
	opens: MessageOpenEvent[];
};
