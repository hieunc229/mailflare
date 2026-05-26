import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/cloudflare";
import { deleteSession, SESSION_COOKIE } from "@/lib/auth/session";

export async function POST() {
	const env = getEnv();
	const jar = await cookies();
	const token = jar.get(SESSION_COOKIE)?.value;
	if (token) await deleteSession(env, token);

	const response = NextResponse.json({ ok: true });
	response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
	return response;
}
