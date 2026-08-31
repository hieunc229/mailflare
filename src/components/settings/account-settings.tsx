"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChangePasswordForm } from "./change-password-form";
import { ForwardingEmailForm } from "./forwarding-email-form";
import { BarkSettingsForm } from "./bark-settings-form";
import { MailboxSignatureForm } from "./mailbox-signature-form";
import { ProfileForm } from "./profile-form";
import { ProfileAvatarForm } from "./profile-avatar-form";
import type { AccountSettingsResponse } from "./types";
import { loadAccountSettings } from "./utils";

export function AccountSettings() {
	const [user, setUser] = useState<AccountSettingsResponse["user"]>();
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;

		loadAccountSettings()
			.then((nextUser) => {
				if (!cancelled) setUser(nextUser);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load account");
			});

		return () => {
			cancelled = true;
		};
	}, []);

	if (error) {
		return <p className="py-8 text-sm text-red-600">{error}</p>;
	}

	if (!user) {
		return (
			<div className="space-y-6 py-4">
				<Skeleton className="h-9 w-40" />
				<Skeleton className="h-72 w-full rounded-3xl" />
			</div>
		);
	}

	return (
		<div className="space-y-8 py-4">
			<div>
				<h1 className="text-3xl font-medium text-neutral-900">Account</h1>
				<p className="mt-1 text-sm text-neutral-500">Manage your account details and sign-in password.</p>
			</div>

			<Card className="rounded-3xl border-0 bg-white px-6">
				<CardHeader>
					<CardTitle>Account details</CardTitle>
					<CardDescription>Your current email is assigned to this account and cannot be changed here.</CardDescription>
				</CardHeader>
				<CardContent className="pb-6">
					<div className="mb-6 flex items-center gap-4 border-b border-neutral-100 pb-6">
						<ProfileAvatarForm name={user.name} />
						<div>
							<p className="text-sm font-medium text-neutral-900">Profile picture</p>
							<p className="mt-1 text-sm text-neutral-500">Choose a picture to show across your account.</p>
						</div>
					</div>
					<ProfileForm
						initialName={user.name}
						initialResetEmail={user.resetEmail ?? ""}
						email={user.email}
					/>
				</CardContent>
			</Card>

			{user.canForwardEmail && (
				<Card className="rounded-3xl border-0 bg-white px-6">
					<CardHeader>
						<CardTitle>Forwarding email</CardTitle>
						<CardDescription>Send a copy of incoming messages to another email address.</CardDescription>
					</CardHeader>
					<CardContent className="pb-6">
						<ForwardingEmailForm initialForwardingEmail={user.forwardingEmail ?? ""} />
					</CardContent>
				</Card>
			)}

			<Card className="rounded-3xl border-0 bg-white px-6">
				<CardHeader>
					<CardTitle>Bark push notifications</CardTitle>
					<CardDescription>Get notified on your iPhone when new mail arrives.</CardDescription>
				</CardHeader>
				<CardContent className="pb-6">
					<BarkSettingsForm initialBarkUrl={user.barkUrl ?? ""} />
				</CardContent>
			</Card>

			<Card className="rounded-3xl border-0 bg-white px-6">
				<CardHeader>
					<CardTitle>Email signature</CardTitle>
					<CardDescription>Configure the signature for the inbox currently selected above.</CardDescription>
				</CardHeader>
				<CardContent className="pb-6">
					<MailboxSignatureForm />
				</CardContent>
			</Card>

			<Card className="rounded-3xl border-0 bg-white px-6">
				<CardHeader>
					<CardTitle>Change password</CardTitle>
					<CardDescription>Use at least 8 characters for your new password.</CardDescription>
				</CardHeader>
				<CardContent className="pb-6">
					<ChangePasswordForm />
				</CardContent>
			</Card>
		</div>
	);
}
