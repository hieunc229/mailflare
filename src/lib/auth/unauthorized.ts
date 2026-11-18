/**
 * Thrown by `requireUser` when nobody is signed in. The `digest` is the one Next.js and vinext use for
 * `unauthorized()`, so a route handler that lets it escape answers 401 instead of a generic 500.
 */
export class UnauthorizedError extends Error {
	readonly digest = "NEXT_HTTP_ERROR_FALLBACK;401";

	constructor() {
		super("Unauthorized");
		this.name = "UnauthorizedError";
	}
}
