import type { LoginResult } from "./types";

export async function submitLogin(form: FormData): Promise<{ ok: boolean; data: LoginResult }> {
	const res = await fetch("/api/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: form.get("email"),
			password: form.get("password"),
		}),
	});

	return {
		ok: res.ok,
		data: (await res.json()) as LoginResult,
	};
}
