import type { ParsedEmail } from "@/lib/email/parse";

export type SpamVerdict = "inbox" | "suspicious" | "spam";
export type SpamClassification = "spam" | "ham";

export type SpamSignal = {
	id: string;
	score: number;
	reason: string;
	metadata?: Record<string, unknown>;
};

/** Verdicts the receiving provider computed itself (SES receipt), trusted over any header in the message. */
export type ProviderVerdicts = {
	spf?: string;
	dkim?: string;
	dmarc?: string;
	spam?: string;
	virus?: string;
};

export type SpamAnalysisInput = {
	mailboxId: string;
	userId: string;
	envelopeFrom: string;
	headers?: Record<string, string>;
	verdicts?: ProviderVerdicts;
	/** Connecting IP recorded by the provider; otherwise read from the topmost Received header. */
	senderIp?: string;
	/** Brands added in the admin spam filter settings, checked alongside the built-in list. */
	brands?: SpamBrand[];
	message: ParsedEmail;
	intelligenceProvider?: SpamIntelligenceProvider;
};

export type SpamAnalysisResult = {
	score: number;
	verdict: SpamVerdict;
	signals: SpamSignal[];
	contentProbability?: number;
	fingerprint: string;
};

export type ReputationKey = { type: "email" | "domain" | "fingerprint"; key: string };

export type PreparedSpamContent = {
	visibleText: string;
	urlDomains: string[];
};

export type SpamIntelligenceInput = {
	senderDomain: string;
	urlDomains: string[];
	fingerprint: string;
	/** IPv4 of the server that delivered the message to our MX, when known. */
	senderIp?: string | null;
};

export interface SpamIntelligenceProvider {
	check(input: SpamIntelligenceInput): Promise<SpamSignal[]>;
}

export type SpamIntelligenceConfig = {
	/** Spamhaus Data Query Service key; public Spamhaus mirrors refuse queries from public resolvers like ours. */
	spamhausDqsKey?: string;
	/** abuse.ch Auth-Key for URLhaus host lookups. */
	abuseChAuthKey?: string;
	/** Registration-date lookups over RDAP; on unless disabled in settings or SPAM_DOMAIN_AGE_CHECK is "off". */
	domainAge: boolean;
	/** Brands the administrator added to the built-in impersonation list. */
	brands: SpamBrand[];
};

/** A brand senders pretend to be, with the domains it really sends from. */
export type SpamBrand = { name: string; domains: string[] };

export type SpamKeySource = "settings" | "env" | null;

export type SpamIntelligenceStatus = {
	/** False until the database migration adding these settings has run. */
	available: boolean;
	spamhaus: { source: SpamKeySource };
	abusech: { source: SpamKeySource };
	domainAge: boolean;
	domainAgeForcedOff: boolean;
	brands: SpamBrand[];
};

export type BayesianResult = {
	probability: number;
	contribution: number;
	trainedMessages: number;
	strongestTokens: Array<{ token: string; probability: number }>;
};
