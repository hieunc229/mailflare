import { AwsError } from "@/lib/aws/client";
import { isValidRegion, SES_RECEIVING_REGIONS } from "@/lib/aws/config";
import { describeActiveRuleSet, getSesAccount } from "@/lib/aws/ses";
import { listBuckets } from "@/lib/aws/s3";
import { listTopics } from "@/lib/aws/sns";
import { getCallerIdentity } from "@/lib/aws/sts";
import type { AwsCapabilityReport, AwsConfig } from "@/lib/aws/aws-types";

async function probe(run: () => Promise<unknown>): Promise<boolean> {
	try { await run(); return true; }
	catch (error) {
		if (error instanceof AwsError && error.accessDenied) return false;
		throw error;
	}
}

/** Thrown for credentials AWS refuses outright, as opposed to missing permissions. */
export class AwsCredentialsError extends Error {}

/**
 * Checks the credentials really belong to an account, then probes each service
 * Mailflare needs with a harmless read, so missing permissions are reported up
 * front instead of halfway through a setup.
 */
export async function validateAwsConfig(config: AwsConfig): Promise<AwsCapabilityReport> {
	if (!isValidRegion(config.region)) throw new AwsCredentialsError(`"${config.region}" is not a valid AWS region`);
	let identity: { accountId: string; arn: string };
	try {
		identity = await getCallerIdentity(config);
	} catch (error) {
		if (error instanceof AwsError) {
			if (/InvalidClientTokenId|SignatureDoesNotMatch|IncompleteSignature|UnrecognizedClient|InvalidAccessKeyId/i.test(error.code)) {
				throw new AwsCredentialsError("AWS rejected these credentials. Check the access key ID and secret.");
			}
			if (/ExpiredToken/i.test(error.code)) throw new AwsCredentialsError("These AWS credentials have expired.");
			throw new AwsCredentialsError(`AWS: ${error.message}`);
		}
		throw error;
	}

	const missing: string[] = [];
	let productionAccess: boolean | null = null;
	const sending = await probe(async () => { productionAccess = (await getSesAccount(config)).productionAccess; });
	if (!sending) missing.push("ses:GetAccount", "ses:SendEmail", "ses:CreateEmailIdentity", "ses:GetEmailIdentity");
	const receivingRegion = SES_RECEIVING_REGIONS.includes(config.region);
	const receiving = await probe(() => describeActiveRuleSet(config));
	if (!receiving) missing.push("ses:DescribeActiveReceiptRuleSet", "ses:CreateReceiptRule", "ses:SetActiveReceiptRuleSet");
	const sns = await probe(() => listTopics(config));
	if (!sns) missing.push("sns:CreateTopic", "sns:Subscribe", "sns:SetTopicAttributes");
	const s3 = await probe(() => listBuckets(config));
	if (!s3) missing.push("s3:CreateBucket", "s3:PutBucketPolicy", "s3:GetObject", "s3:DeleteObject");

	return { ...identity, region: config.region, sending, productionAccess, receivingRegion, receiving, sns, s3, missing };
}

/** The IAM policy that grants everything Mailflare does, for the admin to attach. */
export const AWS_IAM_POLICY = {
	Version: "2012-10-17",
	Statement: [
		{ Effect: "Allow", Action: ["sts:GetCallerIdentity", "ses:GetAccount", "ses:SendEmail", "ses:CreateEmailIdentity", "ses:GetEmailIdentity", "ses:DeleteEmailIdentity", "ses:SetIdentityNotificationTopic"], Resource: "*" },
		{ Effect: "Allow", Action: ["ses:DescribeActiveReceiptRuleSet", "ses:CreateReceiptRuleSet", "ses:SetActiveReceiptRuleSet", "ses:CreateReceiptRule", "ses:UpdateReceiptRule", "ses:DescribeReceiptRule", "ses:DeleteReceiptRule"], Resource: "*" },
		{ Effect: "Allow", Action: ["sns:ListTopics", "sns:CreateTopic", "sns:SetTopicAttributes", "sns:Subscribe", "sns:ListSubscriptionsByTopic"], Resource: "*" },
		{ Effect: "Allow", Action: ["s3:ListAllMyBuckets", "s3:CreateBucket", "s3:PutBucketPolicy", "s3:PutLifecycleConfiguration", "s3:ListBucket", "s3:GetObject", "s3:DeleteObject"], Resource: "*" },
	],
};
