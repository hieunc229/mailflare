import type { B2Config, StorageStatus } from "@/lib/storage/b2-types";

type B2Env = Partial<Pick<CloudflareEnv, "BUCKET" | "B2_KEY_ID" | "B2_APPLICATION_KEY" | "B2_BUCKET" | "B2_ENDPOINT" | "S3_BUCKET" | "S3_REGION" | "S3_ACCESS_KEY_ID" | "S3_SECRET_ACCESS_KEY" | "STORAGE_DRIVER" | "MAILFLARE_RUNTIME">> &
	Partial<Record<"AWS_ACCESS_KEY_ID" | "AWS_SECRET_ACCESS_KEY" | "AWS_REGION" | "AWS_DEFAULT_REGION", string>>;

const ENDPOINT_PATTERN = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/;

/** Accepts `s3.us-west-004.backblazeb2.com` with or without a scheme or trailing slash. */
export function normalizeB2Endpoint(value: string): string {
	return value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

export function b2RegionFromEndpoint(endpoint: string): string | null {
	return ENDPOINT_PATTERN.exec(endpoint)?.[1] ?? null;
}

/**
 * Backblaze B2 settings from the Worker environment (B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT).
 * Returns null when any is missing, which leaves the R2 binding (or local files) in use.
 */
export function getB2Config(env: B2Env): B2Config | null {
	const keyId = env.B2_KEY_ID?.trim();
	const applicationKey = env.B2_APPLICATION_KEY?.trim();
	const bucket = env.B2_BUCKET?.trim();
	const endpoint = env.B2_ENDPOINT ? normalizeB2Endpoint(env.B2_ENDPOINT) : "";
	if (!keyId || !applicationKey || !bucket || !endpoint) return null;
	const region = b2RegionFromEndpoint(endpoint);
	if (!region) return null;
	return { keyId, applicationKey, bucket, endpoint, region };
}

const S3_REGION_PATTERN = /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d$/;

/**
 * AWS S3 settings: S3_BUCKET and S3_REGION, with S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY falling back to the
 * AWS_* variables the SES integration already uses. Backblaze wins when both are configured.
 */
export function getS3Config(env: B2Env): B2Config | null {
	const bucket = env.S3_BUCKET?.trim();
	const region = (env.S3_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION)?.trim();
	const keyId = (env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID)?.trim();
	const applicationKey = (env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY)?.trim();
	if (!bucket || !region || !keyId || !applicationKey || !S3_REGION_PATTERN.test(region)) return null;
	return { keyId, applicationKey, bucket, region, endpoint: `s3.${region}.amazonaws.com` };
}

/** The S3-compatible bucket in use, if any. */
export function getObjectStorageConfig(env: B2Env): (B2Config & { provider: "backblaze" | "s3" }) | null {
	const b2 = getB2Config(env);
	if (b2) return { ...b2, provider: "backblaze" };
	const s3 = getS3Config(env);
	return s3 ? { ...s3, provider: "s3" } : null;
}

/**
 * `STORAGE_DRIVER=database` opts into storing objects in the database itself (see
 * src/lib/storage/db-bucket.ts). It wins over B2/S3/R2 because it is an explicit choice.
 */
export function usesDatabaseStorage(env: B2Env): boolean {
	return env.STORAGE_DRIVER?.trim().toLowerCase() === "database";
}

export function getStorageStatus(env: B2Env): StorageStatus {
	// The explicit driver, or an env whose BUCKET was already swapped for the database store —
	// which is also how the automatic "nothing bound" fallback reports itself.
	if (usesDatabaseStorage(env) || (env.BUCKET as { provider?: string } | undefined)?.provider === "database") {
		return { provider: "database", configured: true, bucket: null, endpoint: null };
	}
	const configured = getObjectStorageConfig(env);
	if (configured) return { provider: configured.provider, configured: true, bucket: configured.bucket, endpoint: configured.endpoint };
	return { provider: env.MAILFLARE_RUNTIME === "node" ? "files" : "r2", configured: true, bucket: null, endpoint: null };
}

/** Names the variables that are set without exposing values, so a half-finished setup can be diagnosed. */
export function describeB2Problem(env: B2Env): string | null {
	if (!getB2Config(env) && !(env.B2_KEY_ID || env.B2_APPLICATION_KEY || env.B2_BUCKET || env.B2_ENDPOINT) && env.S3_BUCKET && !getS3Config(env)) {
		return "AWS S3 needs S3_BUCKET, S3_REGION and credentials (S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).";
	}
	const present = [env.B2_KEY_ID, env.B2_APPLICATION_KEY, env.B2_BUCKET, env.B2_ENDPOINT].filter((value) => value?.trim()).length;
	if (present === 0 || getB2Config(env)) return null;
	if (getS3Config(env)) return null;
	if (present < 4) return "Backblaze B2 needs B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET and B2_ENDPOINT together.";
	return "B2_ENDPOINT must look like s3.us-west-004.backblazeb2.com.";
}
