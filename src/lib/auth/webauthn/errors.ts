import type { AuthErrorCode } from "@/lib/auth/error-codes";

/** A verification failure the route can map to a stable code and status. */
export class PasskeyVerificationError extends Error {
	constructor(
		readonly code: Extract<AuthErrorCode, "passkey_invalid" | "passkey_not_found" | "account_disabled" | "passkey_counter_stale">,
		message = "Passkey could not be verified",
	) {
		super(message);
		this.name = "PasskeyVerificationError";
	}
}

/** The request origin cannot host a ceremony, so no browser prompt can start. */
export class WebAuthnOriginError extends Error {
	constructor(message = "Passkeys need a trusted HTTPS origin. Set APP_URL to this install's public URL.") {
		super(message);
		this.name = "WebAuthnOriginError";
	}
}

/** The stable code for a ceremony that could not be started. */
export function webAuthnUnavailableCode(error: unknown): "passkey_origin" | "passkey_unavailable" {
	return error instanceof WebAuthnOriginError ? "passkey_origin" : "passkey_unavailable";
}
