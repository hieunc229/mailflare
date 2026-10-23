/**
 * Client IP for rate-limit keys. On Workers, cf-connecting-ip is set by the
 * platform; self-hosted sits behind a reverse proxy, so fall back to the
 * proxy-set x-forwarded-for first hop. Without a real per-client key every
 * visitor lands in one shared "unknown" bucket and scanners can lock out
 * legitimate logins.
 */
function clientRateLimitKey(request: Request): string {
	return (
		request.headers.get("cf-connecting-ip")?.trim() ||
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
		"unknown"
	);
}

/** Mobile sign-ins have their own, stricter budget (they skip Turnstile). */
export async function allowDeviceLoginAttempt(env: CloudflareEnv, request: Request): Promise<boolean> {
	const limiter = env.DEVICE_LOGIN_RATE_LIMIT ?? env.LOGIN_RATE_LIMIT;
	if (!limiter) return true;
	try {
		return (await limiter.limit({ key: `device:${clientRateLimitKey(request)}` })).success;
	} catch (error) {
		console.warn("Device login rate limiter unavailable", error);
		return true;
	}
}

export async function allowLoginAttempt(env: CloudflareEnv, request: Request): Promise<boolean> {
	if (!env.LOGIN_RATE_LIMIT) return true;
	try {
		const outcome = await env.LOGIN_RATE_LIMIT.limit({ key: clientRateLimitKey(request) });
		return outcome.success;
	} catch (error) {
		console.warn("Login rate limiter unavailable", error);
		return true;
	}
}
