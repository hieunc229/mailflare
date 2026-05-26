export type Domain = {
	id: string;
	hostname: string;
	status: string;
	routingEnabled: boolean;
	sendingEnabled: boolean;
	zoneId: string;
};

export type DnsRecord = {
	type?: string;
	name?: string;
	content?: string;
	priority?: number;
};

export type DnsStatusSummary = {
	routing: { configured: boolean; missing: string[] };
	sending: { configured: boolean; records: string[] };
};
