import { cookies } from "next/headers";
import { AuthGuard } from "@/components/auth/auth-guard";
import { SETUP_COOKIE } from "@/lib/auth/webauthn/grants";
import { PasskeySetupClient } from "./passkey-setup-client";

export const dynamic = "force-dynamic";

export default async function PasskeySetupPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
	const [{ token }, cookieStore] = await Promise.all([searchParams, cookies()]);
	return (
		<AuthGuard mode="public" allowAuthenticated>
			<PasskeySetupClient token={token ?? cookieStore.get(SETUP_COOKIE)?.value ?? ""} />
		</AuthGuard>
	);
}
