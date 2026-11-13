import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/cloudflare";
import {
	ACCOUNTS_COOKIE,
	cookieOptions,
	isSameOrigin,
	parseAccountTokens,
	resolveAccounts,
	serializeAccountTokens,
} from "@/lib/auth/accounts";
import { deleteSession, getSessionTokenFromRequestHeaders, SESSION_COOKIE } from "@/lib/auth/session";

/** Accounts signed in on this browser. Tokens are never returned. */
export async function GET(request: Request) {
	const env = getEnv();
	const jar = await cookies();
	const active = getSessionTokenFromRequestHeaders(request);
	// Include the current session so accounts signed in before this cookie existed still list.
	const accounts = await resolveAccounts(
		env,
		Array.from(new Set(parseAccountTokens(jar.get(ACCOUNTS_COOKIE)?.value).concat(active ?? []))),
	);
	const response = NextResponse.json({
		accounts: accounts.map(({ token, avatarKey, ...account }) => ({ ...account, active: token === active })),
	});
	response.headers.set("Cache-Control", "no-store");
	return response;
}

/** Remove another signed-in account from this browser and end its session. The active account signs out through /api/auth/logout. */
export async function DELETE(request: Request) {
	if (!isSameOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	const env = getEnv();
	const body = (await request.json().catch(() => null)) as { userId?: unknown } | null;
	const userId = typeof body?.userId === "string" ? body.userId : "";
	const jar = await cookies();
	const active = getSessionTokenFromRequestHeaders(request) ?? jar.get(SESSION_COOKIE)?.value;
	const accounts = await resolveAccounts(env, parseAccountTokens(jar.get(ACCOUNTS_COOKIE)?.value));
	const target = accounts.find((account) => account.userId === userId);
	if (!target) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	if (target.token === active) return NextResponse.json({ error: "Sign out of the active account instead" }, { status: 400 });

	await deleteSession(env, target.token);
	const response = NextResponse.json({ ok: true });
	response.headers.set("Cache-Control", "no-store");
	response.cookies.set(
		ACCOUNTS_COOKIE,
		serializeAccountTokens(accounts.filter((account) => account.userId !== userId).map((account) => account.token)),
		cookieOptions(),
	);
	return response;
}
