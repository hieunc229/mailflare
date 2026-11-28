import { signAwsRequest } from "@/lib/aws/sigv4";
import { xmlTag } from "@/lib/aws/xml";
import type { AwsConfig } from "@/lib/aws/aws-types";

export class AwsError extends Error {
	constructor(message: string, readonly status: number, readonly code: string) {
		super(message);
	}

	get accessDenied(): boolean {
		return /AccessDenied|UnauthorizedOperation|AuthorizationError|NotAuthorized|Forbidden/i.test(this.code) || this.status === 403;
	}
}

async function parseError(response: Response): Promise<AwsError> {
	const text = await response.text().catch(() => "");
	let code = response.headers.get("x-amzn-errortype")?.split(":")[0] ?? "";
	let message = "";
	try {
		const json = JSON.parse(text) as { __type?: string; message?: string; Message?: string };
		code ||= json.__type?.split("#").pop() ?? "";
		message = json.message ?? json.Message ?? "";
	} catch {
		code ||= xmlTag(text, "Code") ?? "";
		message = xmlTag(text, "Message") ?? "";
	}
	return new AwsError(message || `AWS request failed (${response.status})`, response.status, code || `HTTP${response.status}`);
}

export type AwsRequest = {
	config: AwsConfig;
	service: string;
	/** Defaults to `${service}.${region}.amazonaws.com`. */
	host?: string;
	method?: string;
	path?: string;
	query?: Record<string, string>;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	/** Region used to sign; defaults to the config's. */
	region?: string;
	/** Defaults to https; http is for a local S3-compatible server. */
	protocol?: "https" | "http";
	/** "manual" keeps signed requests from being replayed against another host; a 3xx then fails like any error. */
	redirect?: "manual";
};

export async function awsRequest(request: AwsRequest): Promise<Response> {
	const { config, service } = request;
	const region = request.region ?? config.region;
	const url = new URL(`${request.protocol ?? "https"}://${request.host ?? `${service}.${region}.amazonaws.com`}${request.path ?? "/"}`);
	for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value);
	const body = request.body ?? "";
	const method = request.method ?? "GET";
	const headers = await signAwsRequest({ method, url, headers: request.headers ?? {}, body, region, service, credentials: config, });
	const response = await fetch(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body, ...(request.redirect ? { redirect: request.redirect } : {}) });
	if (!response.ok) throw await parseError(response);
	return response;
}

/** AWS JSON REST (SES v2). */
export async function awsJson<T>(request: AwsRequest & { json?: unknown }): Promise<T> {
	const response = await awsRequest({
		...request,
		body: request.json === undefined ? request.body : JSON.stringify(request.json),
		headers: { "Content-Type": "application/json", ...request.headers },
	});
	const text = await response.text();
	return (text ? JSON.parse(text) : {}) as T;
}

/** AWS Query protocol (STS, SNS, SES v1): form-encoded POST, XML back. */
export async function awsQuery(
	config: AwsConfig,
	service: string,
	version: string,
	action: string,
	params: Record<string, string> = {},
	options: { host?: string; signingService?: string } = {},
): Promise<string> {
	const body = new URLSearchParams({ Action: action, Version: version, ...params }).toString();
	const response = await awsRequest({
		config,
		service: options.signingService ?? service,
		host: options.host ?? `${service}.${config.region}.amazonaws.com`,
		method: "POST",
		body,
		headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
	});
	return response.text();
}
