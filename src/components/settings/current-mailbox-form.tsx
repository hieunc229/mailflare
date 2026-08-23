"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { getMailboxAddress, updateCurrentMailboxSettings } from "./utils";

export function CurrentMailboxForm() {
	const { selectedMailbox, setSelectedMailbox, isLoading } = useSelectedMailbox();
	const [displayName, setDisplayName] = useState("");
	const [savedDisplayName, setSavedDisplayName] = useState("");
	const [forwardTo, setForwardTo] = useState("");
	const [savedForwardTo, setSavedForwardTo] = useState("");
	const [status, setStatus] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		const nextName = selectedMailbox?.displayName ?? "";
		const nextForwardTo = selectedMailbox?.forwardTo ?? "";
		setDisplayName(nextName);
		setSavedDisplayName(nextName);
		setForwardTo(nextForwardTo);
		setSavedForwardTo(nextForwardTo);
		setStatus(null);
	}, [selectedMailbox?.id, selectedMailbox?.displayName, selectedMailbox?.forwardTo]);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!selectedMailbox) return;

		setSaving(true);
		setStatus(null);
		try {
			const updated = await updateCurrentMailboxSettings(selectedMailbox.id, { displayName, forwardTo });
			setSelectedMailbox(updated);
			setSavedDisplayName(updated.displayName ?? "");
			setDisplayName(updated.displayName ?? "");
			setSavedForwardTo(updated.forwardTo ?? "");
			setForwardTo(updated.forwardTo ?? "");
			setStatus("Saved");
		} catch (err) {
			setStatus(err instanceof Error ? err.message : "Failed to update mailbox");
		} finally {
			setSaving(false);
		}
	}

	if (isLoading) {
		return (
			<div className="max-w-2xl space-y-6 p-8">
				<Skeleton className="h-8 w-32" />
				<Card>
					<CardContent className="space-y-4 p-6">
						<Skeleton className="h-4 w-24" />
						<Skeleton className="h-10 w-full" />
						<Skeleton className="h-9 w-28" />
					</CardContent>
				</Card>
			</div>
		);
	}

	if (!selectedMailbox) {
		return (
			<div className="max-w-2xl space-y-6 p-8">
				<h1 className="text-2xl font-semibold text-neutral-900">Settings</h1>
				<Card>
					<CardContent className="p-6 text-sm text-neutral-500">
						Select a mailbox to view its settings.
					</CardContent>
				</Card>
			</div>
		);
	}

	const address = getMailboxAddress(selectedMailbox);
	const hasChanges = displayName.trim() !== savedDisplayName || forwardTo.trim() !== savedForwardTo;

	return (
		<div className="max-w-3xl space-y-8 p-8">
			<div>
				<h1 className="text-2xl font-semibold text-neutral-900">Settings</h1>
				<p className="mt-1 text-sm text-neutral-500">{address}</p>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Mailbox</CardTitle>
					<CardDescription>Update the currently selected mailbox.</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={onSubmit} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="displayName">Name</Label>
							<Input
								id="displayName"
								value={displayName}
								onChange={(event) => setDisplayName(event.target.value)}
								placeholder={selectedMailbox.localPart}
								disabled={saving}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="forwardTo">Also forward a copy to</Label>
							<Input
								id="forwardTo"
								type="email"
								value={forwardTo}
								onChange={(event) => setForwardTo(event.target.value)}
								placeholder="backup@example.com"
								disabled={saving}
							/>
							<p className="text-xs text-neutral-500">
								Optional. Every message sent to this mailbox will also be forwarded here as a safety-net
								copy. The destination must already be a verified address in Cloudflare Email Routing.
							</p>
						</div>
						<div className="grid gap-4 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 sm:grid-cols-2">
							<div className="space-y-1">
								<p className="text-xs font-medium uppercase text-neutral-500">Email</p>
								<p className="truncate no-font-mono text-sm text-neutral-900">{address}</p>
							</div>
							<div className="space-y-1">
								<p className="text-xs font-medium uppercase text-neutral-500">Domain</p>
								<p className="truncate no-font-mono text-sm text-neutral-900">{selectedMailbox.hostname}</p>
							</div>
						</div>
						<div className="flex items-center gap-3">
							<Button type="submit" disabled={saving || !hasChanges}>
								<Save className="h-4 w-4" />
								{saving ? "Saving..." : "Save changes"}
							</Button>
							{status && <p className="text-sm text-neutral-500">{status}</p>}
						</div>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
