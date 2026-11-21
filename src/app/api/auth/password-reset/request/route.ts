import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { passwordResetRequestSchema } from "@/lib/validators";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { verifyTurnstileToken } from "@/lib/auth/turnstile";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { requestPasswordReset } from "@/lib/auth/password-reset";
import { trustedResetOrigin } from "@/lib/auth/password-reset-utils";
import { getServerTranslator } from "@/lib/i18n/server";

/**
 * Always answers 200 once the input is well-formed, whether or not the
 * account exists or has a recovery address, so the form reveals nothing.
 */
export async function POST(request: Request) {
	const env = getEnv();
	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid request" }, { status });
	}
	const parsed = passwordResetRequestSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: "Enter the email address you sign in with" }, { status: 400 });
	}
	if (!(await allowLoginAttempt(env, request))) {
		return NextResponse.json({ error: "Too many attempts. Try again shortly." }, { status: 429, headers: { "Retry-After": "60" } });
	}
	if (!(await verifyTurnstileToken(env, request, (body as Record<string, unknown>).turnstileToken))) {
		return NextResponse.json({ error: "Verification failed. Please try again." }, { status: 400 });
	}

	// The link carries a live token, so its origin is never taken from the Host header (see trustedResetOrigin).
	const origin = trustedResetOrigin(env, request.url);
	if (!origin) {
		console.warn("Password reset skipped: set APP_URL to this install's public URL so reset links cannot be built from the Host header");
		return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
	}
	try {
		await requestPasswordReset(env, parsed.data.email, origin, await getServerTranslator());
	} catch (error) {
		// Delivery problems are logged, never surfaced: the answer stays uniform.
		console.error("Password reset request failed", error);
	}
	return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
