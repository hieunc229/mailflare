import { redirect } from "next/navigation";
import { OnboardingClient } from "./onboarding-client";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { userHasMailboxes } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
	const env = getEnv();
	const user = await getCurrentUser(env);
	if (!user) redirect("/login");

	const hasMailboxes = await userHasMailboxes(env, user.id);
	if (hasMailboxes) redirect("/inbox");

	return <OnboardingClient />;
}
