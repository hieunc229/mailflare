import { cookies } from "next/headers";
import { SESSION_COOKIE, getUserFromSession } from "@/lib/auth/session";
import { isMissingColumnError, isMissingTableError } from "@/lib/database-errors";
import { hasValidSessionMutationOrigin } from "./origin";
import { MigrationRequiredError, UnauthorizedError } from "./unauthorized";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The session read behind every auth path. A database behind on migrations (a missing table, or a
 * column a later migration adds) must say so (409) instead of letting the driver error out as a 500
 * no client can act on — `requireUser` already answers that way for its ~72 sites, and the callers
 * that read `getCurrentUser` directly deserve the same answer. Every other failure — an outage, a
 * lock, a real query bug — is rethrown untouched: this catch must not hide one behind a migration
 * message.
 */
async function userFromSession(env: CloudflareEnv, token: string | undefined) {
	try {
		return await getUserFromSession(env, token);
	} catch (error) {
		if (isMissingTableError(error) || isMissingColumnError(error)) throw new MigrationRequiredError();
		throw error;
	}
}

function getBearerToken(request?: Request): string | undefined {
	const authorization = request?.headers.get("Authorization");
	if (!authorization?.startsWith("Bearer ")) return undefined;
	const token = authorization.slice(7).trim();
	return token || undefined;
}

export async function getCurrentUser(env: CloudflareEnv, request?: Request) {
	const bearerToken = getBearerToken(request);
	if (bearerToken) {
		const user = await userFromSession(env, bearerToken);
		return user?.disabled || user?.deletedAt ? null : user;
	}

	// Every handler that authenticates by cookie resolves the user here, so this is the one place that
	// stops a cross-site or same-site-sibling page from riding the cookie on a state-changing request.
	// Bearer tokens (handled above) are not sent automatically by browsers and are exempt.
	if (request && MUTATING_METHODS.has(request.method.toUpperCase()) && !hasValidSessionMutationOrigin(request)) return null;

	const jar = await cookies();
	const token = jar.get(SESSION_COOKIE)?.value;
	const user = await userFromSession(env, token);
	return user?.disabled || user?.deletedAt ? null : user;
}

export async function requireUser(env: CloudflareEnv, request?: Request) {
	let user: Awaited<ReturnType<typeof getCurrentUser>>;
	try {
		user = await getCurrentUser(env, request);
	} catch (error) {
		// A database behind on migrations must say so (409) instead of letting the driver error out
		// as a 500 no client can act on. Every other failure — an outage, a lock, a real query bug —
		// is rethrown untouched: this catch must not hide one behind a migration message.
		if (isMissingTableError(error) || isMissingColumnError(error)) throw new MigrationRequiredError();
		throw error;
	}
	if (!user) throw new UnauthorizedError();
	return user;
}
