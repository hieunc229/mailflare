import { getClientIp } from "./client-ip";

/**
 * Key rate limits by the resolved client IP. Without a per-client key every
 * visitor lands in one shared "unknown" bucket and scanners can lock out
 * legitimate logins; trusting raw forwarding headers here would be worse —
 * a client could rotate them to leave the bucket entirely.
 */
function clientRateLimitKey(request: Request): string {
	return getClientIp(request) ?? "unknown";
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

/**
 * Public booking submissions send mail from the host's address, so they get a per-client budget of their own.
 * Unlike sign-in, this fails closed: with no limiter bound, or one that errors, nobody can trigger that mail.
 */
export async function allowBookingAttempt(env: CloudflareEnv, request: Request): Promise<boolean> {
	if (!env.LOGIN_RATE_LIMIT) {
		console.warn("Booking refused: LOGIN_RATE_LIMIT is not bound");
		return false;
	}
	try {
		return (await env.LOGIN_RATE_LIMIT.limit({ key: `booking:${clientRateLimitKey(request)}` })).success;
	} catch (error) {
		console.warn("Booking rate limiter unavailable", error);
		return false;
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
