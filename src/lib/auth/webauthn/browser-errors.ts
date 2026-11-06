import { WebAuthnError } from "@simplewebauthn/browser";

/** The browser prompt was dismissed, cancelled, or timed out. */
export function isPasskeyCancellation(error: unknown): boolean {
	if (error instanceof WebAuthnError) {
		return error.name === "NotAllowedError" || error.name === "AbortError" || error.code === "ERROR_CEREMONY_ABORTED";
	}
	return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
}

/** The browser or platform cannot perform this ceremony at all. */
export function isPasskeyUnsupported(error: unknown): boolean {
	return error instanceof WebAuthnError && error.name === "NotSupportedError";
}
