import { persistAuthSession } from "@/lib/auth/client";
import { startAuthentication } from "@simplewebauthn/browser";
import type { LoginResult } from "./types";

type PasskeyOptions = {
	options?: unknown;
	ceremonyToken?: string;
	error?: string;
	code?: string;
};

export async function submitLogin(form: FormData): Promise<{ ok: boolean; data: LoginResult }> {
	const res = await fetch("/api/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({
			email: form.get("email"),
			password: form.get("password"),
			turnstileToken: form.get("turnstileToken"),
		}),
	});

	return {
		ok: res.ok,
		data: (await persistAuthSession(res)) as LoginResult,
	};
}

/** Second step: the challenge from the password step plus a TOTP or recovery code. */
export async function submitMfaCode(challengeToken: string, code: string): Promise<{ ok: boolean; data: LoginResult }> {
	const res = await fetch("/api/auth/mfa/verify", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({ challengeToken, code }),
	});
	return { ok: res.ok, data: (await persistAuthSession(res)) as LoginResult };
}

export async function requestPasskeyLoginOptions(): Promise<PasskeyOptions> {
	const res = await fetch("/api/auth/passkey/options", {
		method: "POST",
		signal: AbortSignal.timeout(20_000),
	});
	return (await res.json()) as PasskeyOptions;
}

export async function finishPasskeyLogin(options: PasskeyOptions, response: unknown): Promise<{ ok: boolean; data: LoginResult }> {
	const res = await fetch("/api/auth/passkey/verify", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({ ceremonyToken: options.ceremonyToken, response }),
	});
	return { ok: res.ok, data: (await persistAuthSession(res)) as LoginResult };
}

/** Discoverable passkey sign-in: no email or password prompt. */
export async function submitPasskeyLogin(): Promise<{ ok: boolean; data: LoginResult }> {
	const options = await requestPasskeyLoginOptions();
	if (!options.options || !options.ceremonyToken) {
		return { ok: false, data: { error: options.error, code: options.code } };
	}
	const response = await startAuthentication({
		optionsJSON: options.options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
	});
	return finishPasskeyLogin(options, response);
}

/** The passkey alternative on the second-factor screen. */
export async function submitPasskeyMfa(challengeToken: string): Promise<{ ok: boolean; data: LoginResult }> {
	const optionsRes = await fetch("/api/auth/passkey/mfa/options", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({ challengeToken }),
	});
	const options = (await optionsRes.json()) as PasskeyOptions;
	if (!options.options || !options.ceremonyToken) {
		return { ok: false, data: { error: options.error, code: options.code } };
	}
	const response = await startAuthentication({
		optionsJSON: options.options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
	});
	const res = await fetch("/api/auth/passkey/mfa/verify", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({ challengeToken, ceremonyToken: options.ceremonyToken, response }),
	});
	return { ok: res.ok, data: (await persistAuthSession(res)) as LoginResult };
}
