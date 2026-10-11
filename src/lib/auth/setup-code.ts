import { NextResponse } from "next/server";
import { allowLoginAttempt } from "./rate-limit";
import { getSetupCode, logSetupCode, normalizeSetupCode, SETUP_CODE_HEADER } from "./setup-code-utils";
import { timingSafeEqual } from "./totp";

/**
 * Rejects a first-run setup request that does not carry the setup code, so whoever reaches a fresh install first
 * cannot claim it, or use its Cloudflare token, before the deployer does. Returns null when the request may proceed.
 * `body` is merged into the error so a caller can still report what it checked.
 */
export async function requireSetupCode(
	env: CloudflareEnv,
	request: Request,
	body: Record<string, unknown> = {},
): Promise<NextResponse | null> {
	const setup = await getSetupCode(env);
	if (!setup) {
		return NextResponse.json(
			{ ...body, error: "Set the SETUP_TOKEN secret, or CF_TOKEN, to continue setup.", code: "SETUP_CODE_UNAVAILABLE" },
			{ status: 503 },
		);
	}

	const provided = request.headers.get(SETUP_CODE_HEADER)?.trim();
	if (!provided) {
		// Opening /setup asks for the code, so that is when the deployer goes looking for it in the logs.
		if (setup.derived) logSetupCode(setup.code);
		return NextResponse.json(
			{ ...body, error: "Enter the setup code to continue.", code: "SETUP_CODE_REQUIRED" },
			{ status: 401 },
		);
	}
	if (!(await allowLoginAttempt(env, request))) {
		return NextResponse.json(
			{ ...body, error: "Too many attempts. Wait a minute and try again.", code: "SETUP_CODE_RATE_LIMITED" },
			{ status: 429 },
		);
	}
	if (!timingSafeEqual(normalizeSetupCode(provided), normalizeSetupCode(setup.code))) {
		return NextResponse.json(
			{ ...body, error: "That setup code is not correct.", code: "SETUP_CODE_INVALID" },
			{ status: 401 },
		);
	}
	return null;
}
