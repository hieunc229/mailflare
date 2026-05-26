import { cookies } from "next/headers";
import { SESSION_COOKIE, getUserFromSession } from "@/lib/auth/session";

export async function getCurrentUser(env: CloudflareEnv) {
	const jar = await cookies();
	const token = jar.get(SESSION_COOKIE)?.value;
	return getUserFromSession(env, token);
}

export async function requireUser(env: CloudflareEnv) {
	const user = await getCurrentUser(env);
	if (!user) throw new Error("Unauthorized");
	return user;
}
