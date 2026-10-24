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

export function getCloudflareAuthHint(errors: CfApiError[], path = "") {
	// Cloudflare answers a sending-subdomain create with 401/2036 when the hostname
	// has another service's MX records, so a valid token is not the likely cause.
	if (path.includes("/email/sending/") && errors.some((error) => error.code === 2036)) {
		return " If the token has Email Sending permissions, check the domain for MX records pointing at another mail service; Cloudflare refuses sending setup until they are removed.";
	}
	// 6003 wraps 6102 (bad X-Auth-Key) and 6111 (bad Authorization): the credential is
	// malformed, not merely unauthorized. Global key + email take precedence over CF_TOKEN.
	if (errors.some((error) => error.code === 6003 || error.code === 6102 || error.code === 6111)) {
		return " Cloudflare rejected the auth header format. Check CF_TOKEN / CF_API_KEY for stray quotes, spaces, newlines or a `Bearer ` prefix. An API token pasted into CF_API_KEY fails this way, and CF_API_KEY + CF_EMAIL override CF_TOKEN, so remove them if you use a token. CF_API_KEY must be the Global API Key.";
	}
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

export function getEmailWorkerName(): string {
	return "mailflare";
}
