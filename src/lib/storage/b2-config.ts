import type { B2Config, StorageStatus } from "@/lib/storage/b2-types";

type B2Env = Partial<Pick<CloudflareEnv, "B2_KEY_ID" | "B2_APPLICATION_KEY" | "B2_BUCKET" | "B2_ENDPOINT" | "S3_BUCKET" | "S3_REGION" | "S3_ENDPOINT" | "S3_FORCE_PATH_STYLE" | "S3_ACCESS_KEY_ID" | "S3_SECRET_ACCESS_KEY" | "MAILFLARE_RUNTIME">> &
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
/** Region labels of S3-compatible providers: "auto", "fsn1", "us-east-1", "eu-central-2". */
const COMPATIBLE_REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A bucket usable as a DNS label (bucket.endpoint). Dots are refused: they break the wildcard certificate. */
const DNS_BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const PATH_BUCKET_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;
/** One DNS label of a host name: letters, digits, hyphens (and underscores some providers use), no edge hyphens. */
const HOST_LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type S3EndpointResult =
	| { ok: true; host: string; protocol: "https" | "http"; loopback: boolean; ipLiteral: boolean }
	| { ok: false; reason: "invalid" | "insecure" };

/**
 * Parses S3_ENDPOINT: a host with an optional scheme and port, lowercased. https only; http is accepted for
 * localhost, 127.0.0.1 and [::1] on the Node runtime (a local MinIO). Paths, queries, fragments and
 * credentials are refused.
 */
export function parseS3Endpoint(value: string, runtime?: string): S3EndpointResult {
	const trimmed = value.trim();
	const raw = trimmed.replace(/\/+$/, "");
	if (!raw || trimmed.endsWith("://") || /[?#\s\\@]/.test(raw)) return { ok: false, reason: "invalid" };
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase();
	if (scheme && scheme !== "http" && scheme !== "https") return { ok: false, reason: "invalid" };
	let url: URL;
	try { url = new URL(scheme ? raw : `https://${raw}`); } catch { return { ok: false, reason: "invalid" }; }
	if (url.pathname !== "/" || url.username || url.password || !url.hostname) return { ok: false, reason: "invalid" };
	// No DNS name to hang a bucket on: an IP address or a single label such as "minio".
	const ipLiteral = url.hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || !url.hostname.includes(".");
	if (!ipLiteral && !url.hostname.split(".").every((label) => HOST_LABEL.test(label))) return { ok: false, reason: "invalid" };
	if (url.port === "0") return { ok: false, reason: "invalid" };
	const loopback = LOOPBACK_HOSTS.has(url.hostname);
	if (url.protocol === "http:" && !(loopback && runtime === "node")) return { ok: false, reason: "insecure" };
	return { ok: true, host: url.host, protocol: url.protocol === "https:" ? "https" : "http", loopback, ipLiteral };
}

type S3Resolution = { config: B2Config } | { problem: string } | null;

function enabled(value: string | undefined): boolean {
	return /^(true|1)$/i.test(value?.trim() ?? "");
}

function resolveS3(env: B2Env): S3Resolution {
	const bucket = env.S3_BUCKET?.trim();
	const endpointValue = env.S3_ENDPOINT?.trim();
	// The AWS_* variables belong to AWS (SES): never sign a request to another provider with them.
	const region = (endpointValue ? env.S3_REGION : (env.S3_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION))?.trim();
	const keyId = (endpointValue ? env.S3_ACCESS_KEY_ID : (env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID))?.trim();
	const applicationKey = (endpointValue ? env.S3_SECRET_ACCESS_KEY : (env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY))?.trim();
	if (!endpointValue) {
		if (!bucket || !region || !keyId || !applicationKey || !S3_REGION_PATTERN.test(region)) return null;
		return { config: { keyId, applicationKey, bucket, region, endpoint: `s3.${region}.amazonaws.com` } };
	}
	const endpoint = parseS3Endpoint(endpointValue, env.MAILFLARE_RUNTIME);
	if (!endpoint.ok) {
		return { problem: endpoint.reason === "insecure"
			? "S3_ENDPOINT must use https. http is accepted only for localhost, 127.0.0.1 or [::1] on the Node runtime (a local MinIO)."
			: "S3_ENDPOINT must be a host such as fsn1.your-objectstorage.com, with an optional https:// and port, and no path, query or credentials." };
	}
	if (!bucket || !region || !keyId || !applicationKey) {
		return { problem: "S3-compatible storage needs S3_BUCKET, S3_REGION, S3_ENDPOINT and credentials (S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY)." };
	}
	if (!COMPATIBLE_REGION_PATTERN.test(region)) {
		return { problem: "With S3_ENDPOINT, S3_REGION must be lowercase letters, digits and hyphens (up to 63), the region your provider documents, such as auto, fsn1 or eu-central-2." };
	}
	// An IP address or localhost cannot take a bucket subdomain.
	const pathStyle = enabled(env.S3_FORCE_PATH_STYLE) || endpoint.ipLiteral || endpoint.loopback;
	if (pathStyle ? !PATH_BUCKET_PATTERN.test(bucket) || bucket === "." || bucket === ".." : !DNS_BUCKET_PATTERN.test(bucket)) {
		return { problem: pathStyle
			? "S3_BUCKET may contain only letters, digits, dots, hyphens and underscores."
			: "S3_BUCKET is not DNS-safe (3 to 63 lowercase letters, digits and hyphens, no dots), so bucket.endpoint cannot be used. Set S3_FORCE_PATH_STYLE=true to address the bucket by path." };
	}
	return { config: { keyId, applicationKey, bucket, region, endpoint: endpoint.host, protocol: endpoint.protocol, pathStyle, compatible: true } };
}

/**
 * S3 settings: S3_BUCKET and S3_REGION, with S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY falling back to the
 * AWS_* variables the SES integration already uses. Without S3_ENDPOINT this is AWS S3 (AWS-shaped region,
 * regional host). With S3_ENDPOINT it is any S3-compatible provider. Backblaze wins when both are configured.
 */
export function getS3Config(env: B2Env): B2Config | null {
	const resolved = resolveS3(env);
	return resolved && "config" in resolved ? resolved.config : null;
}

export type ObjectStorageProvider = "backblaze" | "s3" | "s3-compatible";

/** The S3-compatible bucket in use, if any. */
export function getObjectStorageConfig(env: B2Env): (B2Config & { provider: ObjectStorageProvider }) | null {
	const b2 = getB2Config(env);
	if (b2) return { ...b2, provider: "backblaze" };
	const s3 = getS3Config(env);
	return s3 ? { ...s3, provider: env.S3_ENDPOINT?.trim() ? "s3-compatible" : "s3" } : null;
}

export function getStorageStatus(env: B2Env): StorageStatus {
	const configured = getObjectStorageConfig(env);
	if (configured?.provider === "s3-compatible") {
		const endpoint = configured.protocol === "http" ? `http://${configured.endpoint}` : configured.endpoint;
		return { provider: "s3-compatible", configured: true, bucket: configured.bucket, endpoint, pathStyle: !!configured.pathStyle };
	}
	if (configured) return { provider: configured.provider, configured: true, bucket: configured.bucket, endpoint: configured.endpoint };
	// Vercel starts only with a bucket or a Blob store, so no bucket means Blob.
	if (env.MAILFLARE_RUNTIME === "vercel") return { provider: "vercel-blob", configured: true, bucket: null, endpoint: null };
	return { provider: env.MAILFLARE_RUNTIME === "node" ? "files" : "r2", configured: true, bucket: null, endpoint: null };
}

/** Names the variables that are set without exposing values, so a half-finished setup can be diagnosed. */
export function describeB2Problem(env: B2Env): string | null {
	if (env.S3_ENDPOINT?.trim() && !getB2Config(env)) {
		const resolved = resolveS3(env);
		return resolved && "problem" in resolved ? resolved.problem : null;
	}
	if (!getB2Config(env) && !(env.B2_KEY_ID || env.B2_APPLICATION_KEY || env.B2_BUCKET || env.B2_ENDPOINT) && env.S3_BUCKET && !getS3Config(env)) {
		return "AWS S3 needs S3_BUCKET, S3_REGION and credentials (S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).";
	}
	const present = [env.B2_KEY_ID, env.B2_APPLICATION_KEY, env.B2_BUCKET, env.B2_ENDPOINT].filter((value) => value?.trim()).length;
	if (present === 0 || getB2Config(env)) return null;
	if (getS3Config(env)) return null;
	if (present < 4) return "Backblaze B2 needs B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET and B2_ENDPOINT together.";
	return "B2_ENDPOINT must look like s3.us-west-004.backblazeb2.com.";
}

/**
 * A broken S3_ENDPOINT setup, for the runtimes that would otherwise quietly keep using R2 or local files.
 * Null when it is fine, unset, or Backblaze is in use.
 */
export function storageStartupProblem(env: B2Env): string | null {
	if (!env.S3_ENDPOINT?.trim() || getB2Config(env) || getS3Config(env)) return null;
	return describeB2Problem(env);
}
