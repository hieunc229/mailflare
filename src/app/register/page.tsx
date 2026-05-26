import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { RegisterClient } from "./register-client";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
	const user = await getCurrentUser(getEnv());
	if (user) redirect("/inbox");

	return <RegisterClient />;
}
