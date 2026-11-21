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
