"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BarkSettingsFormProps } from "./types";
import { saveBarkSettings, testBarkNotification } from "./utils";

export function BarkSettingsForm({ initialBarkUrl }: BarkSettingsFormProps) {
	const [barkUrl, setBarkUrl] = useState(initialBarkUrl);
	const [savedBarkUrl, setSavedBarkUrl] = useState(initialBarkUrl);
	const [status, setStatus] = useState<string | null>(null);
	const [statusType, setStatusType] = useState<"success" | "error">("success");
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);

	async function onSave() {
		setSaving(true);
		setStatus(null);
		try {
			const saved = await saveBarkSettings(barkUrl);
			setBarkUrl(saved);
			setSavedBarkUrl(saved);
			setStatusType("success");
			setStatus("Saved");
		} catch (error) {
			setStatusType("error");
			setStatus(error instanceof Error ? error.message : "Failed to save Bark settings");
		} finally {
			setSaving(false);
		}
	}

	async function onTest() {
		setTesting(true);
		setStatus(null);
		try {
			await testBarkNotification();
			setStatusType("success");
			setStatus("Test notification sent");
		} catch (error) {
			setStatusType("error");
			setStatus(error instanceof Error ? error.message : "Test push failed");
		} finally {
			setTesting(false);
		}
	}

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="barkUrl">Bark push URL</Label>
				<Input
					id="barkUrl"
					value={barkUrl}
					onChange={(event) => setBarkUrl(event.target.value)}
					placeholder="https://api.day.app/YOUR_KEY"
				/>
				<p className="text-xs leading-5 text-neutral-500">
					Receive a push notification on your iPhone when a new message arrives. Install the Bark
					app and paste your device key from{" "}
					<a
						href="https://bark.day.app/"
						target="_blank"
						rel="noreferrer"
						className="text-blue-600 underline-offset-2 hover:underline"
					>
						bark.day.app
					</a>
					.
				</p>
			</div>
			<div className="flex items-center gap-3">
				<Button type="button" onClick={onSave} disabled={saving || barkUrl.trim() === savedBarkUrl}>
					{saving ? "Saving..." : "Save"}
				</Button>
				<Button
					type="button"
					variant="outline"
					onClick={onTest}
					disabled={testing || !savedBarkUrl || barkUrl.trim() !== savedBarkUrl}
					title={barkUrl.trim() !== savedBarkUrl ? "Save your changes before sending a test notification" : undefined}
				>
					{testing ? "Sending..." : "Send test notification"}
				</Button>
				{status && (
					<p className={`text-sm ${statusType === "error" ? "text-red-600" : "text-neutral-500"}`}>
						{status}
					</p>
				)}
			</div>
		</div>
	);
}