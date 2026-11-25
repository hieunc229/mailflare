import type { CfApiError } from "@/lib/cloudflare-api.types";

export class CloudflareApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly path: string,
		readonly errors: CfApiError[],
	) {
		super(message);
		this.name = "CloudflareApiError";
	}
}

export function isCloudflareApiErrorCode(error: unknown, code: number): boolean {
	return error instanceof CloudflareApiError && error.errors.some((item) => item.code === code);
}

/** The zone is gone from the account or the token cannot reach it (404, 403): nothing in it can be read or changed from here. */
export function isCloudflareZoneUnavailable(error: unknown): boolean {
	return error instanceof Error && error.name === "CloudflareApiError" && ((error as CloudflareApiError).status === 404 || (error as CloudflareApiError).status === 403);
}
