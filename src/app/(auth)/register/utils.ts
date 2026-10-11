import { clearClientSessionToken } from "@/lib/auth/client";
import { SETUP_CODE_HEADER } from "@/lib/auth/setup-code-utils";
import type {
	DomainSetupResult,
	MxCheckResult,
	RegisterResult,
	SetupPreparationResult,
	SetupStatus,
} from "./types";

function setupHeaders(setupCode: string, json = false): HeadersInit {
	const headers: Record<string, string> = json ? { "Content-Type": "application/json" } : {};
	if (setupCode.trim()) headers[SETUP_CODE_HEADER] = setupCode.trim();
	return headers;
}

export async function prepareSetup(setupCode: string): Promise<{ ok: boolean; data: SetupPreparationResult }> {
	const res = await fetch("/api/setup/prepare", { method: "POST", headers: setupHeaders(setupCode) });
	return {
		ok: res.ok,
		data: (await res.json()) as SetupPreparationResult,
	};
}

export async function getSetupStatus(): Promise<SetupStatus> {
	const res = await fetch("/api/setup/status");
	const data = (await res.json()) as SetupStatus;
	if (!res.ok) throw new Error(data.error ?? "Could not load setup status");
	return data;
}

export async function submitPrimaryDomain(hostname: string, setupCode: string): Promise<{ ok: boolean; data: DomainSetupResult }> {
	const res = await fetch("/api/setup/domain", {
		method: "POST",
		headers: setupHeaders(setupCode, true),
		body: JSON.stringify({ hostname }),
	});

	return {
		ok: res.ok,
		data: (await res.json()) as DomainSetupResult,
	};
}

export async function checkExistingMx(hostname: string, setupCode: string): Promise<{ ok: boolean; data: MxCheckResult }> {
	const res = await fetch("/api/setup/domain/mx", {
		method: "POST",
		headers: setupHeaders(setupCode, true),
		body: JSON.stringify({ hostname }),
	});

	return {
		ok: res.ok,
		data: (await res.json()) as MxCheckResult,
	};
}

export async function submitRegistration(
	form: FormData,
	payload: { firstRun: boolean; domain: string; enableSending?: boolean; replaceMxRecords?: boolean },
	setupCode: string,
): Promise<{ ok: boolean; data: RegisterResult }> {
	const res = await fetch("/api/auth/register", {
		method: "POST",
		headers: setupHeaders(setupCode, true),
		body: JSON.stringify(
			payload.firstRun
				? {
						domain: payload.domain,
						enableSending: payload.enableSending,
						replaceMxRecords: payload.replaceMxRecords,
						username: form.get("username"),
						password: form.get("password"),
						resetEmail: form.get("resetEmail"),
						turnstileToken: form.get("turnstileToken"),
					}
				: {
						username: form.get("username"),
						password: form.get("password"),
						resetEmail: form.get("resetEmail"),
						turnstileToken: form.get("turnstileToken"),
					},
		),
	});

	const data = (await res.json()) as RegisterResult;
	if (res.ok) clearClientSessionToken();
	return { ok: res.ok, data };
}
