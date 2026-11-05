import { getBranding } from "@/lib/branding/service";
import { WebAuthnOriginError } from "./errors";

export type WebAuthnConfig = {
	origin: string;
	rpID: string;
	rpName: string;
};

function isLocalhost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/**
 * Credentials are bound to one RP ID and origin. APP_URL is the canonical
 * public origin; without it the request origin is used, which is correct on
 * Workers and on a direct Node deployment, but not behind a proxy. Refuse a
 * non-local HTTP origin because browsers reject WebAuthn there anyway.
 */
export async function getWebAuthnConfig(env: CloudflareEnv, request: Request): Promise<WebAuthnConfig> {
	const configured = env.APP_URL?.trim();
	const url = new URL(configured || request.url);
	if (url.protocol !== "https:" && !isLocalhost(url.hostname)) {
		throw new WebAuthnOriginError();
	}
	const { appName } = await getBranding(env);
	return { origin: url.origin, rpID: url.hostname, rpName: appName };
}

/** Where mailed links and admin recovery links should point. */
export function getPublicOrigin(env: CloudflareEnv, request: Request): string {
	const configured = env.APP_URL?.trim();
	return configured ? new URL(configured).origin : new URL(request.url).origin;
}
