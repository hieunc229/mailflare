import type { CfApiError, CfAuth } from "@/lib/cloudflare-api.types";

export function getCloudflareAuth(env: CloudflareEnv): CfAuth {
	const token = env.CF_TOKEN?.trim();
	const key = env.CF_API_KEY?.trim();
	const email = env.CF_EMAIL?.trim();

	if (key && email) {
		return { kind: "global-key", email, key };
	}

	if (token) {
		return { kind: "token", token };
	}

	if (key && !email) {
		throw new Error("CF_EMAIL is required when using CF_API_KEY");
	}

	throw new Error("CF_TOKEN or CF_API_KEY is not configured");
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
	const hasAuthError = errors.some(
		(error) =>
			error.code === 10000 ||
			error.code === 9109 ||
			/auth/i.test(error.message) ||
			/token/i.test(error.message),
	);
	if (!hasAuthError) return "";

	return " Verify CF_TOKEN with `curl https://api.cloudflare.com/client/v4/user/tokens/verify -H \"Authorization: Bearer <token>\"`. Use the token secret value without `Bearer`, or use CF_API_KEY plus CF_EMAIL for a Global API Key.";
}

export function getEmailWorkerName(env: CloudflareEnv): string {
	return env.CF_EMAIL_WORKER_NAME?.trim() || "mailflare";
}
