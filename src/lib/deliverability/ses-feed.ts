import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings, domains } from "@/db/schema";
import { requireAwsConfig } from "@/lib/aws/config";
import { setIdentityNotificationTopic } from "@/lib/aws/ses";
import { createTopic, listSubscriptions, setTopicPolicy, subscribeHttps } from "@/lib/aws/sns";
import { getCallerIdentity } from "@/lib/aws/sts";
import { isPublicHttps } from "@/lib/domains/resend-receiving";
import type { AwsConfig } from "@/lib/aws/aws-types";

const TOPIC_NAME = "mailflare-feedback";
const NOTIFICATION_TYPES = ["Bounce", "Complaint"] as const;

export type SesFeedState = { region: string; topicArn: string; token: string; endpoint: string; identities: string[] };

export async function getSesFeedState(env: CloudflareEnv): Promise<SesFeedState | null> {
	try {
		const [row] = await getDb(env).select({ value: appSettings.sesFeedback }).from(appSettings).where(eq(appSettings.id, "default")).limit(1);
		return row?.value ? JSON.parse(row.value) as SesFeedState : null;
	} catch {
		return null;
	}
}

async function saveState(env: CloudflareEnv, state: SesFeedState | null): Promise<void> {
	const values = { sesFeedback: state ? JSON.stringify(state) : null, updatedAt: new Date() };
	await getDb(env).insert(appSettings).values({ id: "default", ...values }).onConflictDoUpdate({ target: appSettings.id, set: values });
}

async function attach(config: AwsConfig, identity: string, topicArn: string | null): Promise<void> {
	for (const type of NOTIFICATION_TYPES) await setIdentityNotificationTopic(config, identity, type, topicArn);
}

/**
 * Points SES bounce and complaint notifications for every SES sending domain at one SNS topic that
 * calls /api/provider-events/ses. Idempotent, so running it again repairs a partial setup.
 */
export async function setupSesFeed(env: CloudflareEnv, origin: string): Promise<SesFeedState> {
	const config = await requireAwsConfig(env);
	if (!isPublicHttps(origin)) {
		throw new Error("SNS delivers events by calling this app over public HTTPS. Set APP_URL to your public address (localhost will not work).");
	}
	const { accountId } = await getCallerIdentity(config);
	const previous = await getSesFeedState(env);
	const token = previous?.token ?? crypto.randomUUID().replace(/-/g, "");
	const endpoint = `${origin.replace(/\/$/, "")}/api/provider-events/ses?token=${token}`;
	const topicArn = await createTopic(config, TOPIC_NAME);
	await setTopicPolicy(config, topicArn, {
		Version: "2008-10-17",
		Statement: [
			{
				Sid: "AllowOwner",
				Effect: "Allow",
				Principal: { AWS: "*" },
				Action: ["SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:AddPermission", "SNS:RemovePermission", "SNS:DeleteTopic", "SNS:Subscribe", "SNS:ListSubscriptionsByTopic", "SNS:Publish"],
				Resource: topicArn,
				Condition: { StringEquals: { "AWS:SourceOwner": accountId } },
			},
			{
				Sid: "AllowSESPublish",
				Effect: "Allow",
				Principal: { Service: "ses.amazonaws.com" },
				Action: "SNS:Publish",
				Resource: topicArn,
				Condition: { StringEquals: { "AWS:SourceAccount": accountId } },
			},
		],
	});
	if (!(await listSubscriptions(config, topicArn)).some((subscription) => subscription.endpoint === endpoint)) {
		await subscribeHttps(config, topicArn, endpoint);
	}
	const sesDomains = await getDb(env).select({ hostname: domains.hostname }).from(domains).where(eq(domains.sendingProvider, "ses"));
	const identities: string[] = [];
	for (const { hostname } of sesDomains) {
		await attach(config, hostname, topicArn);
		identities.push(hostname);
	}
	const state: SesFeedState = { region: config.region, topicArn, token, endpoint, identities };
	await saveState(env, state);
	return state;
}

/** Detaches the identities and forgets the feed. The topic stays: SNS topics cost nothing. */
export async function removeSesFeed(env: CloudflareEnv): Promise<void> {
	const state = await getSesFeedState(env);
	if (!state) return;
	const config = await requireAwsConfig(env);
	for (const identity of state.identities) await attach(config, identity, null);
	await saveState(env, null);
}

/** Called when a domain starts sending through SES: a failure here must never break sending setup. */
export async function attachSesFeedToIdentity(env: CloudflareEnv, hostname: string): Promise<void> {
	try {
		const state = await getSesFeedState(env);
		if (!state) return;
		await attach(await requireAwsConfig(env), hostname, state.topicArn);
		if (!state.identities.includes(hostname)) await saveState(env, { ...state, identities: [...state.identities, hostname] });
	} catch (error) {
		console.error(`SES bounce feed was not attached to ${hostname}`, error);
	}
}
