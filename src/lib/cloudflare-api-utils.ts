import type { CfApiError, CfAuth } from "@/lib/cloudflare-api.types";

export function getCloudflareAuth(env: CloudflareEnv): CfAuth {
	const token = env.CF_TOKEN?.trim();
	const key = env.CLOUDFLARE_API_KEY?.trim();
	const email = env.CLOUDFLARE_EMAIL?.trim();

	if (key && email) {
		return { kind: "global-key", email, key };
	}

	if (token) {
		return { kind: "token", token };
	}

	if (key && !email) {
		throw new Error("CLOUDFLARE_EMAIL is required when using CLOUDFLARE_API_KEY");
	}

	throw new Error("CF_TOKEN or CLOUDFLARE_API_KEY is not configured");
}

export function getCloudflareAuthHeaders(auth: CfAuth): HeadersInit {
	if (auth.kind === "global-key") {
		return {
			"X-Auth-Email": auth.email,
			"X-Auth-Key": auth.key,
		};
	}

	return {
		Authorization: `Bearer ${auth.token}`,
	};
}

export function formatCloudflareError(path: string, status: number, statusText: string, errors: CfApiError[]) {
	const details = errors
		.map((error) => {
			const code = error.code ? `code ${error.code}: ` : "";
			return `${code}${error.message}`;
		})
		.join("; ");
	const message = details || statusText || "Cloudflare API request failed";

	return `Cloudflare API ${status} on ${path}: ${message}`;
}

export function getCloudflareAuthHint(errors: CfApiError[]) {
	const hasAuthError = errors.some((error) => error.code === 10000 || /auth/i.test(error.message));
	if (!hasAuthError) return "";

	return " Use CF_TOKEN for a scoped API token, or CLOUDFLARE_API_KEY plus CLOUDFLARE_EMAIL for a Global API Key.";
}

export function getEmailWorkerName(env: CloudflareEnv): string {
	return env.CF_EMAIL_WORKER_NAME?.trim() || "lumal";
}
