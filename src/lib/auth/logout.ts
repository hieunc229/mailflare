import { authFetch, clearClientSessionToken, setClientSessionToken } from "@/lib/auth/client";
import { setAppBadgeCount } from "@/lib/push/app-badge";

/** Returns true when another signed-in account on this browser took over. */
export async function logoutClientSession(): Promise<boolean> {
	let nextToken: string | undefined;
	try {
		const response = await authFetch("/api/auth/logout", {
			method: "POST",
			redirectOnUnauthorized: false,
		});
		nextToken = ((await response.json().catch(() => null)) as { token?: string } | null)?.token;
	} catch {
		// Local logout must complete even when the server request is unavailable.
	} finally {
		clearClientSessionToken();
		setAppBadgeCount(0);
	}
	if (!nextToken) return false;
	setClientSessionToken(nextToken);
	return true;
}
