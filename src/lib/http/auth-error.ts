import { NextResponse } from "next/server";
import { AUTH_ERROR_MESSAGES, type AuthErrorCode } from "@/lib/auth/error-codes";

/** JSON error with a stable code the client can translate. */
export function authError(code: AuthErrorCode, status: number, headers: Record<string, string> = {}) {
	return NextResponse.json(
		{ error: AUTH_ERROR_MESSAGES[code], code },
		{ status, headers: { "Cache-Control": "no-store", ...headers } },
	);
}

export function isLastAuthMethodError(error: unknown): boolean {
	const message = String(error);
	return message.includes("last-auth-method") || message.includes("second-factor-unavailable");
}

export function isUniqueCredentialError(error: unknown): boolean {
	return /unique|duplicate/i.test(String(error));
}
