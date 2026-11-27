import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import type { AwsConfig, AwsConfigStatus } from "@/lib/aws/aws-types";

/** Regions where SES can receive mail (SES inbound is not offered everywhere). */
export const SES_RECEIVING_REGIONS = [
	"us-east-1", "us-east-2", "us-west-2", "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
	"ca-central-1", "eu-central-1", "eu-west-1", "eu-west-2", "sa-east-1", "us-gov-west-1",
];

const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

export function isValidRegion(region: string): boolean {
	return REGION_PATTERN.test(region);
}

type StoredAws = { accessKeyId?: string; secretAccessKey?: string; region?: string; accountId?: string };

async function readStored(env: CloudflareEnv): Promise<StoredAws | null> {
	const [row] = await getDb(env).select({ awsConfig: appSettings.awsConfig }).from(appSettings).where(eq(appSettings.id, "default")).limit(1);
	if (!row?.awsConfig) return null;
	try { return JSON.parse(row.awsConfig) as StoredAws; } catch { return null; }
}

function readEnvConfig(env: CloudflareEnv): AwsConfig | null {
	const vars = env as unknown as Record<string, string | undefined>;
	const accessKeyId = vars.AWS_ACCESS_KEY_ID?.trim();
	const secretAccessKey = vars.AWS_SECRET_ACCESS_KEY?.trim();
	const region = (vars.AWS_REGION ?? vars.AWS_DEFAULT_REGION)?.trim();
	return accessKeyId && secretAccessKey && region ? { accessKeyId, secretAccessKey, region } : null;
}

/** The AWS_* environment variables, falling back to the saved credentials. */
export async function getAwsConfig(env: CloudflareEnv): Promise<AwsConfig | null> {
	const fromEnv = readEnvConfig(env);
	if (fromEnv) return fromEnv;
	const stored = await readStored(env);
	return stored?.accessKeyId && stored.secretAccessKey && stored.region
		? { accessKeyId: stored.accessKeyId, secretAccessKey: stored.secretAccessKey, region: stored.region }
		: null;
}

export async function requireAwsConfig(env: CloudflareEnv): Promise<AwsConfig> {
	const config = await getAwsConfig(env);
	if (!config) throw new Error("AWS is selected but no credentials are configured");
	return config;
}

export async function getAwsConfigStatus(env: CloudflareEnv): Promise<AwsConfigStatus> {
	const fromEnv = !!readEnvConfig(env);
	const stored = fromEnv ? null : await readStored(env);
	const config = await getAwsConfig(env);
	if (!config) return { configured: false, source: null, region: null, accessKeyHint: null, accountId: null };
	return {
		configured: true,
		source: fromEnv ? "environment" : "settings",
		region: config.region,
		accessKeyHint: config.accessKeyId.slice(-4),
		accountId: stored?.accountId ?? null,
	};
}

export async function saveAwsConfig(env: CloudflareEnv, config: AwsConfig, accountId: string): Promise<void> {
	const values = { awsConfig: JSON.stringify({ ...config, accountId }), updatedAt: new Date() };
	await getDb(env).insert(appSettings).values({ id: "default", ...values }).onConflictDoUpdate({ target: appSettings.id, set: values });
}

export async function clearAwsConfig(env: CloudflareEnv): Promise<void> {
	await getDb(env).update(appSettings).set({ awsConfig: null, updatedAt: new Date() }).where(eq(appSettings.id, "default"));
}
