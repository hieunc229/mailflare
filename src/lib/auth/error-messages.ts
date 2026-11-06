import type { TranslationKey } from "@/lib/i18n/types";
import type { AuthErrorCode } from "./error-codes";

const ERROR_KEYS: Record<AuthErrorCode, TranslationKey> = {
	rate_limited: "authError.rateLimited",
	passkey_unavailable: "authError.passkeyUnavailable",
	passkey_expired: "authError.passkeyExpired",
	passkey_invalid: "authError.passkeyInvalid",
	passkey_not_found: "authError.passkeyNotFound",
	passkey_already_registered: "authError.passkeyAlreadyRegistered",
	passkey_disabled: "authError.accountDisabled",
	passkey_counter_stale: "authError.passkeyInvalid",
	passkey_origin: "authError.passkeyOrigin",
	setup_invalid: "authError.setupInvalid",
	session_expired: "authError.sessionExpired",
	verification_required: "authError.verificationRequired",
	verification_failed: "authError.verificationFailed",
	last_method: "authError.lastMethod",
	passkey_only_password: "authError.passkeyOnlyPassword",
	account_disabled: "authError.accountDisabled",
	passkey_cancelled: "authError.passkeyCancelled",
	code_mismatch: "authError.codeMismatch",
	invalid_credentials: "authError.invalidCredentials",
	password_incorrect: "authError.passwordIncorrect",
	invalid_request: "authError.invalidRequest",
	action_conflict: "authError.actionConflict",
	recovery_cleanup_failed: "authError.recoveryCleanupFailed",
};

/** Translate a server error code, falling back to a call-site key. */
export function authErrorText(code: unknown, t: (key: TranslationKey) => string, fallbackKey: TranslationKey): string {
	if (typeof code === "string" && code in ERROR_KEYS) return t(ERROR_KEYS[code as AuthErrorCode]);
	return t(fallbackKey);
}
