import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/cloudflare";
import { isSameOriginRequest } from "@/lib/auth/origin";
import {
	ACCOUNTS_COOKIE,
	cookieOptions,
	parseAccountTokens,
	resolveAccounts,
	serializeAccountTokens,
} from "@/lib/auth/accounts";
import { SESSION_COOKIE } from "@/lib/auth/session";

/**
 * Make another signed-in account the active one. The client names a user id;
 * the token comes from the httpOnly accounts cookie and is re-validated here.
 * The token is returned because the web client mirrors the active session
 * in its bearer header, exactly as it does after a normal login.
 */
export async function POST(request: Request) {
	if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	const env = getEnv();
	const body = (await request.json().catch(() => null)) as { userId?: unknown } | null;
	const userId = typeof body?.userId === "string" ? body.userId : "";
	const jar = await cookies();
	const accounts = await resolveAccounts(env, parseAccountTokens(jar.get(ACCOUNTS_COOKIE)?.value));
	const target = accounts.find((account) => account.userId === userId);
	if (!target) return NextResponse.json({ error: "Sign in again to use this account" }, { status: 401 });

	const response = NextResponse.json({ ok: true, token: target.token, redirect: "/inbox" });
	response.headers.set("Cache-Control", "no-store");
	response.cookies.set(SESSION_COOKIE, target.token, cookieOptions());
	// Prune dead entries while we are here.
	response.cookies.set(ACCOUNTS_COOKIE, serializeAccountTokens(accounts.map((account) => account.token)), cookieOptions());
	return response;
}
