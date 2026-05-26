import type { DomainSetupResult, RegisterResult, SetupStatus } from "./types";

export async function getSetupStatus(): Promise<SetupStatus> {
	const res = await fetch("/api/setup/status");
	return (await res.json()) as SetupStatus;
}

export async function submitPrimaryDomain(form: FormData): Promise<{ ok: boolean; data: DomainSetupResult }> {
	const res = await fetch("/api/setup/domain", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ hostname: form.get("domain") }),
	});

	return {
		ok: res.ok,
		data: (await res.json()) as DomainSetupResult,
	};
}

export async function submitRegistration(
	form: FormData,
	payload: { firstRun: boolean; domain: string },
): Promise<{ ok: boolean; data: RegisterResult }> {
	const res = await fetch("/api/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(
			payload.firstRun
				? {
						domain: payload.domain,
						username: form.get("username"),
						password: form.get("password"),
						resetEmail: form.get("resetEmail"),
					}
				: {
						username: form.get("username"),
						password: form.get("password"),
						resetEmail: form.get("resetEmail"),
					},
		),
	});

	return {
		ok: res.ok,
		data: (await res.json()) as RegisterResult,
	};
}
