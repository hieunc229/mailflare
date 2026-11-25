import { awsJson, awsQuery, AwsError } from "@/lib/aws/client";
import { xmlBlocks, xmlTag, xmlTags } from "@/lib/aws/xml";
import type { AwsConfig, SesIdentityStatus } from "@/lib/aws/aws-types";

// --- SES v2 (sending, identities) -------------------------------------------------

export async function getSesAccount(config: AwsConfig): Promise<{ productionAccess: boolean; sendingEnabled: boolean }> {
	const account = await awsJson<{ ProductionAccessEnabled?: boolean; SendingEnabled?: boolean }>({ config, service: "ses", host: `email.${config.region}.amazonaws.com`, path: "/v2/email/account" });
	return { productionAccess: !!account.ProductionAccessEnabled, sendingEnabled: account.SendingEnabled !== false };
}

type SesIdentity = {
	VerifiedForSendingStatus?: boolean;
	DkimAttributes?: { Status?: string; Tokens?: string[] };
};

function toIdentityStatus(hostname: string, identity: SesIdentity | null): SesIdentityStatus {
	if (!identity) return { registered: false, verified: false, dkimStatus: "NOT_REGISTERED", records: [] };
	return {
		registered: true,
		verified: !!identity.VerifiedForSendingStatus,
		dkimStatus: identity.DkimAttributes?.Status ?? "NOT_STARTED",
		records: (identity.DkimAttributes?.Tokens ?? []).map((token) => ({
			type: "CNAME" as const,
			name: `${token}._domainkey.${hostname}`,
			value: `${token}.dkim.amazonses.com`,
		})),
	};
}

const sesV2 = (config: AwsConfig, path: string) => ({ config, service: "ses", host: `email.${config.region}.amazonaws.com`, path });

export async function getSesIdentity(config: AwsConfig, hostname: string): Promise<SesIdentityStatus> {
	try {
		const identity = await awsJson<SesIdentity>(sesV2(config, `/v2/email/identities/${encodeURIComponent(hostname)}`));
		return toIdentityStatus(hostname, identity);
	} catch (error) {
		if (error instanceof AwsError && (error.code === "NotFoundException" || error.status === 404)) return toIdentityStatus(hostname, null);
		throw error;
	}
}

export async function createSesIdentity(config: AwsConfig, hostname: string): Promise<SesIdentityStatus> {
	try {
		const identity = await awsJson<SesIdentity>({ ...sesV2(config, "/v2/email/identities"), method: "POST", json: { EmailIdentity: hostname, DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" } } });
		return toIdentityStatus(hostname, identity);
	} catch (error) {
		if (error instanceof AwsError && error.code === "AlreadyExistsException") return getSesIdentity(config, hostname);
		throw error;
	}
}

export async function deleteSesIdentity(config: AwsConfig, hostname: string): Promise<void> {
	try {
		await awsJson({ ...sesV2(config, `/v2/email/identities/${encodeURIComponent(hostname)}`), method: "DELETE" });
	} catch (error) {
		if (!(error instanceof AwsError && error.status === 404)) throw error;
	}
}

export type SesSendInput = {
	from: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	html?: string;
	text?: string;
	headers?: Record<string, string>;
	attachments?: { filename: string; type: string; content: ArrayBuffer; disposition: "attachment" | "inline"; contentId?: string | null }[];
};

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

export async function sendSesEmail(config: AwsConfig, input: SesSendInput): Promise<{ messageId: string }> {
	const headers = Object.entries(input.headers ?? {}).filter(([name]) => name.toLowerCase() !== "message-id").map(([Name, Value]) => ({ Name, Value }));
	const result = await awsJson<{ MessageId: string }>({
		...sesV2(config, "/v2/email/outbound-emails"),
		method: "POST",
		json: {
			FromEmailAddress: input.from,
			Destination: { ToAddresses: input.to, ...(input.cc?.length ? { CcAddresses: input.cc } : {}), ...(input.bcc?.length ? { BccAddresses: input.bcc } : {}) },
			Content: {
				Simple: {
					Subject: { Data: input.subject, Charset: "UTF-8" },
					Body: {
						...(input.text ? { Text: { Data: input.text, Charset: "UTF-8" } } : {}),
						...(input.html ? { Html: { Data: input.html, Charset: "UTF-8" } } : {}),
					},
					...(headers.length ? { Headers: headers } : {}),
					...(input.attachments?.length ? {
						Attachments: input.attachments.map((attachment) => ({
							RawContent: toBase64(attachment.content),
							FileName: attachment.filename,
							ContentType: attachment.type,
							ContentDisposition: attachment.disposition === "inline" ? "INLINE" : "ATTACHMENT",
							...(attachment.disposition === "inline" && attachment.contentId ? { ContentId: attachment.contentId } : {}),
							ContentTransferEncoding: "BASE64",
						})),
					} : {}),
				},
			},
		},
	});
	// SES rewrites Message-ID to <id@email.amazonses.com> (us-east-1) or <id@region.amazonses.com>.
	const domain = config.region === "us-east-1" ? "email.amazonses.com" : `${config.region}.amazonses.com`;
	return { messageId: `<${result.MessageId}@${domain}>` };
}

// --- SES v1 (receipt rules; not available in v2) ---------------------------------

const query = (config: AwsConfig, action: string, params: Record<string, string> = {}) =>
	awsQuery(config, "email", "2010-12-01", action, params, { host: `email.${config.region}.amazonaws.com`, signingService: "ses" });

/** SES v1: routes Bounce or Complaint notifications of an identity to an SNS topic; a null topic detaches it. */
export async function setIdentityNotificationTopic(config: AwsConfig, identity: string, type: "Bounce" | "Complaint", topicArn: string | null): Promise<void> {
	await query(config, "SetIdentityNotificationTopic", { Identity: identity, NotificationType: type, ...(topicArn ? { SnsTopic: topicArn } : {}) });
}

export async function describeActiveRuleSet(config: AwsConfig): Promise<{ name: string | null; rules: string[] }> {
	const xml = await query(config, "DescribeActiveReceiptRuleSet");
	const metadata = xmlBlocks(xml, "Metadata")[0] ?? "";
	const rulesXml = xmlBlocks(xml, "Rules")[0] ?? "";
	return { name: xmlTag(metadata, "Name"), rules: xmlBlocks(rulesXml, "member").map((member) => xmlTag(member, "Name") ?? "").filter(Boolean) };
}

export async function createRuleSet(config: AwsConfig, name: string): Promise<void> {
	try { await query(config, "CreateReceiptRuleSet", { RuleSetName: name }); }
	catch (error) { if (!(error instanceof AwsError && error.code === "AlreadyExists")) throw error; }
}

export async function activateRuleSet(config: AwsConfig, name: string): Promise<void> {
	await query(config, "SetActiveReceiptRuleSet", { RuleSetName: name });
}

export type ReceiptRuleInput = { ruleSet: string; name: string; recipient: string; bucket: string; prefix: string; topicArn: string };

function ruleParams(input: ReceiptRuleInput): Record<string, string> {
	return {
		RuleSetName: input.ruleSet,
		"Rule.Name": input.name,
		"Rule.Enabled": "true",
		"Rule.ScanEnabled": "true",
		"Rule.TlsPolicy": "Optional",
		"Rule.Recipients.member.1": input.recipient,
		"Rule.Actions.member.1.S3Action.BucketName": input.bucket,
		"Rule.Actions.member.1.S3Action.ObjectKeyPrefix": input.prefix,
		"Rule.Actions.member.1.S3Action.TopicArn": input.topicArn,
	};
}

export async function upsertReceiptRule(config: AwsConfig, input: ReceiptRuleInput): Promise<void> {
	try { await query(config, "CreateReceiptRule", ruleParams(input)); }
	catch (error) {
		if (error instanceof AwsError && error.code === "AlreadyExists") await query(config, "UpdateReceiptRule", ruleParams(input));
		else throw error;
	}
}

export async function describeReceiptRule(config: AwsConfig, ruleSet: string, name: string): Promise<boolean> {
	try { await query(config, "DescribeReceiptRule", { RuleSetName: ruleSet, RuleName: name }); return true; }
	catch (error) {
		if (error instanceof AwsError && /DoesNotExist/.test(error.code)) return false;
		throw error;
	}
}

export async function deleteReceiptRule(config: AwsConfig, ruleSet: string, name: string): Promise<void> {
	try { await query(config, "DeleteReceiptRule", { RuleSetName: ruleSet, RuleName: name }); }
	catch (error) { if (!(error instanceof AwsError && /DoesNotExist/.test(error.code))) throw error; }
}

export { xmlTags };
