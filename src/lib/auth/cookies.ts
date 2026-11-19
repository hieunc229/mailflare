import { cookies } from "next/headers";
import { SESSION_COOKIE, getUserFromSession } from "@/lib/auth/session";
import { hasValidSessionMutationOrigin } from "./origin";
import { UnauthorizedError } from "./unauthorized";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

	// Every handler that authenticates by cookie resolves the user here, so this is the one place that
	// stops a cross-site or same-site-sibling page from riding the cookie on a state-changing request.
	// Bearer tokens (handled above) are not sent automatically by browsers and are exempt.
	if (request && MUTATING_METHODS.has(request.method.toUpperCase()) && !hasValidSessionMutationOrigin(request)) return null;

	const jar = await cookies();
	const token = jar.get(SESSION_COOKIE)?.value;
	const user = await getUserFromSession(env, token);
	return user?.disabled || user?.deletedAt ? null : user;
}

export async function requireUser(env: CloudflareEnv, request?: Request) {
	const user = await getCurrentUser(env, request);
	if (!user) throw new UnauthorizedError();
	return user;
}
