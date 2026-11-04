import type { ProviderVerdicts } from "@/lib/spam/types";

export type SnsEnvelope = {
	Type?: string;
	MessageId?: string;
	TopicArn?: string;
	Message?: string;
	Subject?: string;
	Timestamp?: string;
	SubscribeURL?: string;
	Token?: string;
	SignatureVersion?: string;
	Signature?: string;
	SigningCertURL?: string;
};

export type SesNotification = {
	from: string;
	recipients: string[];
	bucket: string;
	key: string;
	virusFailed: boolean;
	headers: Record<string, string>;
	verdicts: ProviderVerdicts;
};

type Verdict = { status?: string };

type RawNotification = {
	notificationType?: string;
	mail?: { source?: string; destination?: string[]; headers?: { name: string; value: string }[] };
	receipt?: {
		recipients?: string[];
		spfVerdict?: Verdict;
		dkimVerdict?: Verdict;
		dmarcVerdict?: Verdict;
		spamVerdict?: Verdict;
		virusVerdict?: Verdict;
		action?: { type?: string; bucketName?: string; objectKey?: string };
	};
};

/** Reads the JSON an SES S3 receipt action publishes to SNS; null for anything else. */
export function parseSesNotification(message: string): SesNotification | null {
	let parsed: RawNotification;
	try { parsed = JSON.parse(message) as RawNotification; } catch { return null; }
	const action = parsed.receipt?.action;
	if (parsed.notificationType !== "Received" || action?.type !== "S3" || !action.bucketName || !action.objectKey) return null;
	const receipt = parsed.receipt;
	const recipients = receipt?.recipients ?? parsed.mail?.destination ?? [];
	// Repeated headers keep their first (topmost) value: that is the hop nearest to us, the one a sender cannot forge.
	const headers: Record<string, string> = {};
	for (const header of parsed.mail?.headers ?? []) {
		const name = header.name.toLowerCase();
		if (!(name in headers)) headers[name] = header.value;
	}
	return {
		from: parsed.mail?.source ?? "",
		recipients,
		bucket: action.bucketName,
		key: action.objectKey,
		virusFailed: receipt?.virusVerdict?.status === "FAIL",
		headers,
		verdicts: {
			spf: receipt?.spfVerdict?.status,
			dkim: receipt?.dkimVerdict?.status,
			dmarc: receipt?.dmarcVerdict?.status,
			spam: receipt?.spamVerdict?.status,
			virus: receipt?.virusVerdict?.status,
		},
	};
}

export function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return diff === 0;
}
