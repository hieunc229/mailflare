import { cookies } from "next/headers";
import { SESSION_COOKIE, getUserFromSession } from "@/lib/auth/session";

function getBearerToken(request?: Request): string | undefined {
	const authorization = request?.headers.get("Authorization");
	if (!authorization?.startsWith("Bearer ")) return undefined;
	const token = authorization.slice(7).trim();
	return token || undefined;
}

export async function getCurrentUser(env: CloudflareEnv, request?: Request) {
	const bearerToken = getBearerToken(request);
	if (bearerToken) {
		const user = await getUserFromSession(env, bearerToken);
		return user?.disabled || user?.deletedAt ? null : user;
	}

	const jar = await cookies();
	const token = jar.get(SESSION_COOKIE)?.value;
	const user = await getUserFromSession(env, token);
	return user?.disabled || user?.deletedAt ? null : user;
}

export async function requireUser(env: CloudflareEnv, request?: Request) {
	const user = await getCurrentUser(env, request);
	if (!user) throw new Error("Unauthorized");
	return user;
}
