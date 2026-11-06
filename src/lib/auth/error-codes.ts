/**
 * Stable machine-readable error codes for authentication and passkey flows.
 * The UI translates these instead of displaying server prose, which keeps
 * errors consistent across every locale.
 */
export type AuthErrorCode =
	| "rate_limited"
	| "passkey_unavailable"
	| "passkey_expired"
	| "passkey_invalid"
	| "passkey_not_found"
	| "passkey_already_registered"
	| "passkey_disabled"
	| "passkey_counter_stale"
	| "passkey_origin"
	| "setup_invalid"
	| "session_expired"
	| "verification_required"
	| "verification_failed"
	| "last_method"
	| "passkey_only_password"
	| "account_disabled"
	| "passkey_cancelled"
	| "code_mismatch"
	| "invalid_credentials"
	| "password_incorrect"
	| "invalid_request"
	| "action_conflict"
	| "recovery_cleanup_failed";

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
	rate_limited: "Too many attempts. Try again shortly.",
	passkey_unavailable: "Passkey sign-in is unavailable.",
	passkey_expired: "This passkey attempt has expired. Start again.",
	passkey_invalid: "This passkey could not be verified.",
	passkey_not_found: "This passkey is no longer registered.",
	passkey_already_registered: "This passkey is already registered.",
	passkey_disabled: "This account is disabled.",
	passkey_counter_stale: "This passkey could not be verified. Try again.",
	passkey_origin: "Passkeys need a trusted HTTPS address for this installation.",
	setup_invalid: "This setup link is invalid or has expired.",
	session_expired: "Your session has expired. Sign in again.",
	verification_required: "Confirm your identity before continuing.",
	verification_failed: "Verification failed. Try again.",
	last_method: "Keep another way to sign in before removing this one.",
	passkey_only_password: "This account uses passkeys only. Send it a recovery link instead.",
	account_disabled: "This account is disabled.",
	passkey_cancelled: "The passkey prompt was cancelled or timed out.",
	code_mismatch: "That code did not match.",
	invalid_credentials: "Invalid email or password.",
	password_incorrect: "Password is incorrect.",
	invalid_request: "Invalid request.",
	action_conflict: "Another security change is in progress. Refresh and try again.",
	recovery_cleanup_failed: "The new passkey was created, but older sign-in methods could not be removed. Sign in with the new passkey, then review Security settings.",
};
