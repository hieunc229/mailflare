export type CfDnsRecord = {
	id?: string;
	type?: string;
	name?: string;
	content?: string;
	priority?: number;
	ttl?: number;
	proxied?: boolean;
	comment?: string;
	tags?: string[];
};

export type CfApiError = {
	code?: number;
	message: string;
	documentation_url?: string;
	source?: unknown;
};

export type CfResponse<T> = {
	success: boolean;
	errors: CfApiError[];
	messages?: CfApiError[];
	result: T;
};

export type CfAuth =
	| {
			kind: "token";
			token: string;
	  }
	| {
			kind: "global-key";
			email: string;
			key: string;
	  };

export type CfEmailRoutingRule = {
	id?: string;
	actions?: {
		type: "drop" | "forward" | "worker";
		value?: string[];
	}[];
	enabled?: boolean;
	matchers?: {
		type: "all" | "literal";
		field?: "to";
		value?: string;
	}[];
	name?: string;
	priority?: number;
	tag?: string;
};

export type CfSendingSubdomain = {
	tag: string;
	name: string;
	enabled: boolean;
	/** The selector Cloudflare signs DKIM with, published at `<selector>._domainkey.<name>`. */
	dkim_selector?: string;
	return_path_domain?: string;
	created?: string;
	modified?: string;
};

export type CfEmailRoutingRuleChange = {
	zoneId: string;
	ruleId: string;
	previous?: CfEmailRoutingRule;
};
