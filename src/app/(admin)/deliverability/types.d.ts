export type SuppressionMode = "off" | "record" | "enforce";

export type DeliverabilitySettings = {
	suppressionMode: SuppressionMode;
	canEdit: boolean;
	feeds: { resend: boolean; ses: { identities: string[] } | null };
};

export type DomainOption = { id: string; hostname: string };

export type SuppressionRow = {
	id: string;
	email: string;
	reason: "hard_bounce" | "complaint" | "manual";
	source: "resend" | "ses" | "dsn" | "admin";
	detail: string | null;
	confirmed: boolean;
	eventCount: number;
	lastEventAt: string;
};

export type SuppressionPage = { items: SuppressionRow[]; total: number };

export type DmarcPlan = { address: string; before: string | null; after: string | null; changed: boolean; manual: boolean };

export type OpenAlert = {
	id: string;
	kind: "spoofing" | "auth_regression" | "no_reports";
	day: string;
	detail: { sources?: { sourceIp: string; messages: number; failed: number; reporter?: string }[]; total?: number; lastReportAt?: string | null };
	createdAt: string;
};

export type DmarcOverview = {
	address: string;
	enabled: boolean;
	alertEmail: boolean;
	enabledAt: string | null;
	lastReportAt: string | null;
	receivingProvider: string;
	manualZone: boolean;
	alerts: OpenAlert[];
	dns: { record: string | null; hasAddress: boolean } | { error: true };
};

export type DmarcSeriesDay = { day: string; pass: number; failDelivered: number; quarantined: number; rejected: number };
export type DmarcSource = { sourceIp: string; sourceHost: string | null; messages: number; passMessages: number; dkimMessages: number; spfMessages: number; worstDisposition: "none" | "quarantine" | "reject"; reporters: number };
export type DmarcReporter = { reporterOrg: string; reports: number; messages: number; passMessages: number };
export type DmarcRecentReport = { id: string; reporterOrg: string | null; dateBegin: string | null; status: string; error: string | null; messageCount: number; verifiedReporter: boolean; receivedAt: string };
export type DmarcStats = { days: 7 | 30 | 90; series: DmarcSeriesDay[]; sources: DmarcSource[]; reporters: DmarcReporter[]; unverifiedReports: number; recentReports: DmarcRecentReport[] };
export type DmarcRange = 7 | 30 | 90;

export type ReportsResponse =
	| { kind: "preview"; plan: DmarcPlan }
	| { kind: "ok"; plan?: DmarcPlan };

export type TlsStats = {
	days: DmarcRange;
	series: { day: string; success: number; failure: number }[];
	reporters: { reporterOrg: string; success: number; failure: number }[];
	policies: { policyType: string; mxHost: string | null; success: number; failure: number }[];
	failureTypes: { resultType: string; failure: number }[];
	unverifiedReports: number;
	recentReports: DmarcRecentReport[];
};

export type TlsOverview = {
	address: string;
	enabled: boolean;
	reportsEnabled: boolean;
	manualZone: boolean;
	dns: { record: string | null; hasAddress: boolean } | { error: true };
	stats: TlsStats;
};

export type TlsRptResponse = { kind: "ok"; plan: { address: string; before: string | null; after: string | null; changed: boolean; manual: boolean } };

export type MtaStsState = {
	host: string;
	policyUrl: string;
	mode: "none" | "testing" | "enforce";
	status: "off" | "testing" | "enforce" | "retiring";
	policyId: string | null;
	mx: string[];
	unverifiedMx: string[];
	maxAge: number;
	policy: string | null;
	verifiedAt: string | null;
	retireAfter: string | null;
	txt?: { name: string; content: string; manual: boolean };
};

export type MtaStsOverview = MtaStsState & {
	manualZone: boolean;
	dns: { record: string | null; matches: boolean } | { error: true };
	/** The live MX hosts next to the policy's list; null while no policy is published. */
	mxDrift: { liveMx: string[]; differs: boolean } | { error: true } | null;
};
export type MtaStsBody = { mode: "testing" | "enforce" | "none"; maxAge?: number; acknowledgeRisk?: boolean };
