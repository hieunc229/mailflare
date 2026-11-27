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

/**
 * Thrown by `requireUser` when the auth read failed because the database is behind on migrations
 * (a missing table, or a column a later migration adds). Answers 409 instead of the 500 the raw
 * driver error would have produced, which a signed-in browser otherwise loops on as "signed out".
 *
 * The `digest` channel carries a status only: vinext answers `NEXT_HTTP_ERROR_FALLBACK;<status>`
 * with an empty body, so this is not the `{ error, code: "MIGRATION_REQUIRED" }` JSON the routes
 * that catch a missing column themselves return (the deliverability, promotions, tracking and
 * subscriptions routes, and the `migrationRequired` helper the auth routes use). A thrown error is
 * the only way to cover the ~72 `requireUser` call sites without editing each one; a caller that
 * needs the JSON body should catch this error. It is deliberately a *different* error from
 * `UnauthorizedError`, so nothing can mistake a pending migration for a signed-out visitor.
 */
export class MigrationRequiredError extends Error {
	readonly digest = "NEXT_HTTP_ERROR_FALLBACK;409";

	constructor() {
		super("Apply pending database migrations first");
		this.name = "MigrationRequiredError";
	}
}
