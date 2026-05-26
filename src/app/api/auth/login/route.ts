import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { loginSchema } from "@/lib/validators";
import { userHasMailboxes } from "@/lib/user";

export async function POST(request: Request) {
	const env = getEnv();
	const body = await request.json();
	const parsed = loginSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const [user] = await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);
	if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
		return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
	}

	const hasMailboxes = await userHasMailboxes(env, user.id);
	const token = await createSession(env, user.id);
	const response = NextResponse.json({
		ok: true,
		redirect: hasMailboxes ? "/inbox" : "/onboarding",
	});
	response.cookies.set(SESSION_COOKIE, token, {
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		maxAge: 60 * 60 * 24 * 30,
	});
	return response;
}
