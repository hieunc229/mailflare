import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { LoginClient } from "./login-client";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
	const user = await getCurrentUser(getEnv());
	if (user) redirect("/inbox");

	return <LoginClient />;
}
