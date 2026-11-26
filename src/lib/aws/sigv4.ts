import type { AwsCredentials } from "@/lib/aws/aws-types";

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
	const bytes = typeof data === "string" ? encoder.encode(data) : data;
	return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
	const imported = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return crypto.subtle.sign("HMAC", imported, encoder.encode(data));
}

const rfc3986 = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export type SignInput = {
	method: string;
	url: URL;
	headers: Record<string, string>;
	body: string | ArrayBuffer | Uint8Array;
	region: string;
	service: string;
	credentials: AwsCredentials;
	now?: Date;
};

function canonicalQueryString(url: URL): string {
	return [...url.searchParams.entries()]
		.map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
		.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
		.map(([name, value]) => `${name}=${value}`)
		.join("&");
}

async function signingSignature(secretAccessKey: string, dateStamp: string, region: string, service: string, stringToSign: string): Promise<string> {
	const kDate = await hmac(encoder.encode(`AWS4${secretAccessKey}`), dateStamp);
	const kRegion = await hmac(kDate, region);
	const kService = await hmac(kRegion, service);
	const kSigning = await hmac(kService, "aws4_request");
	return hex(await hmac(kSigning, stringToSign));
}

export type PresignInput = {
	method: string;
	url: URL;
	/** Headers besides `host` the caller must send with exactly these values. */
	headers?: Record<string, string>;
	region: string;
	credentials: AwsCredentials;
	expiresSeconds: number;
	now?: Date;
};

/** A presigned S3 URL (query-string signature, unsigned payload), so a browser can transfer an object itself. */
export async function presignS3Url(input: PresignInput): Promise<string> {
	const { method, region, credentials } = input;
	const url = new URL(input.url);
	const amzDate = (input.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
	const dateStamp = amzDate.slice(0, 8);
	const scope = `${dateStamp}/${region}/s3/aws4_request`;
	const normalized = Object.entries({ ...input.headers, host: url.host })
		.map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const signedHeaders = normalized.map(([name]) => name).join(";");

	url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
	url.searchParams.set("X-Amz-Credential", `${credentials.accessKeyId}/${scope}`);
	url.searchParams.set("X-Amz-Date", amzDate);
	url.searchParams.set("X-Amz-Expires", String(input.expiresSeconds));
	url.searchParams.set("X-Amz-SignedHeaders", signedHeaders);
	if (credentials.sessionToken) url.searchParams.set("X-Amz-Security-Token", credentials.sessionToken);

	const query = canonicalQueryString(url);
	const canonicalHeaders = normalized.map(([name, value]) => `${name}:${value}\n`).join("");
	const canonicalRequest = [method, url.pathname || "/", query, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
	const signature = await signingSignature(credentials.secretAccessKey, dateStamp, region, "s3", stringToSign);
	return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${signature}`;
}

/**
 * AWS Signature Version 4. Returns the headers to send, including Authorization.
 * Web Crypto only, so it runs on Workers and in the Node build alike.
 */
export async function signAwsRequest(input: SignInput): Promise<Record<string, string>> {
	const { method, url, region, service, credentials } = input;
	const amzDate = (input.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
	const dateStamp = amzDate.slice(0, 8);
	const payloadHash = await sha256Hex(input.body);

	const headers: Record<string, string> = { ...input.headers, host: url.host, "x-amz-date": amzDate };
	if (service === "s3") headers["x-amz-content-sha256"] = payloadHash;
	if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

	const normalized = Object.entries(headers)
		.map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const signedHeaders = normalized.map(([name]) => name).join(";");
	const canonicalHeaders = normalized.map(([name, value]) => `${name}:${value}\n`).join("");

	// S3 signs the path as sent; every other service signs it percent-encoded twice.
	const canonicalPath = service === "s3"
		? url.pathname || "/"
		: (url.pathname || "/").split("/").map((segment) => rfc3986(decodeURIComponent(segment))).join("/");
	const canonicalQuery = canonicalQueryString(url);

	const canonicalRequest = [method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
	const scope = `${dateStamp}/${region}/${service}/aws4_request`;
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

	const signature = await signingSignature(credentials.secretAccessKey, dateStamp, region, service, stringToSign);

	return {
		...headers,
		Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
}
