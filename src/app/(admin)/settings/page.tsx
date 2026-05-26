import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ProfileForm } from "@/components/settings/profile-form";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";

export default async function SettingsPage() {
	const env = getEnv();
	const user = await getCurrentUser(env);
	if (!user) return null;

	return (
		<div className="space-y-6 max-w-2xl">
			<h1 className="text-2xl font-semibold">Settings</h1>
			<Card>
				<CardHeader>
					<CardTitle>Account</CardTitle>
					<CardDescription>{user.email}</CardDescription>
				</CardHeader>
				<CardContent>
					<ProfileForm initialName={user.name} email={user.email} />
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Cloudflare API</CardTitle>
				</CardHeader>
				<CardContent className="text-sm text-neutral-500 space-y-2">
					<p>
						Domain onboarding uses <code>CF_TOKEN</code> with Zone + Email Routing + Email
						Sending permissions.
					</p>
					<p>Domains must already be zones in your Cloudflare account.</p>
				</CardContent>
			</Card>
		</div>
	);
}
