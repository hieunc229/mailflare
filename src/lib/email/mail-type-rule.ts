/** The only `mail_type` value so far: newsletters, promotions and mailing-list mail (see `isBulkMail`). */
export const MAIL_TYPE_BULK = "bulk";

/**
 * Error code the rule API returns when a `mail_type` rule would lose mail (reject, or forward
 * without keeping a copy). The UI translates it; the code itself is an API value.
 */
export const MAIL_TYPE_UNSAFE_ACTION = "mail_type_unsafe_action";

/**
 * Picks the message to show for a failed rule request. The API answers with a plain string or
 * a flattened validation error; the unsafe-action code is kept as is so the caller can translate it.
 */
export function ruleErrorMessage(error: unknown, fallback: string): string {
	if (typeof error === "string") return error;
	const fields = (error as { fieldErrors?: Record<string, string[] | undefined> } | null)?.fieldErrors;
	if (fields && Object.values(fields).some((messages) => messages?.includes(MAIL_TYPE_UNSAFE_ACTION))) return MAIL_TYPE_UNSAFE_ACTION;
	return fallback;
}
