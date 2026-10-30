import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ACCOUNTS_COOKIE, rememberLogin } from "@/lib/auth/accounts";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { recordAuthActivity } from "@/lib/auth/activity";
import type { AuthActivityAction } from "@/lib/auth/activity-types";

/**
 * The one place a verified sign-in turns into a session: cookie, Bearer token
 * for the client, account switcher entry, and audit log.
 */
export async function completeLogin(
	env: CloudflareEnv,
	request: Request,
	userId: string,
	options: { activity?: AuthActivityAction; body?: Record<string, unknown> } = {},
): Promise<NextResponse> {
	const token = await createSession(env, userId);
	await recordAuthActivity(env, { action: options.activity ?? "auth.login", userId, request });
	const response = NextResponse.json({
		ok: true,
		token,
		redirect: "/inbox",
		...options.body,
	});
	response.headers.set("Cache-Control", "no-store");
	response.cookies.set(SESSION_COOKIE, token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
		maxAge: 60 * 60 * 24 * 30,
	});
	const accountsJar = await cookies();
	await rememberLogin(env, response, accountsJar.get(ACCOUNTS_COOKIE)?.value, token, accountsJar.get(SESSION_COOKIE)?.value);
	return response;
}
