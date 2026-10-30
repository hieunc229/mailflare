import { persistAuthSession } from "@/lib/auth/client";
import type { PasskeySetupContext, PasskeySetupOptionsResponse, PasskeySetupResult } from "./types";

export async function loadPasskeySetupContext(token: string): Promise<{ ok: boolean; data: PasskeySetupContext }> {
	const res = await fetch(`/api/auth/passkey/setup/context?token=${encodeURIComponent(token)}`, {
		signal: AbortSignal.timeout(15_000),
	});
	return { ok: res.ok, data: (await res.json()) as PasskeySetupContext };
}

export async function startPasskeySetup(token: string): Promise<PasskeySetupOptionsResponse> {
	const res = await fetch("/api/auth/passkey/setup/options", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({ token }),
	});
	return (await res.json()) as PasskeySetupOptionsResponse;
}

export async function finishPasskeySetup(input: {
	token: string;
	ceremonyToken: string;
	response: unknown;
	name: string;
}): Promise<{ ok: boolean; data: PasskeySetupResult }> {
	const res = await fetch("/api/auth/passkey/setup/verify", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(30_000),
		body: JSON.stringify(input),
	});
	return { ok: res.ok, data: (await persistAuthSession(res)) as PasskeySetupResult };
}
