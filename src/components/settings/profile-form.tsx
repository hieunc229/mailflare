"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ProfileForm({ initialName, email }: { initialName: string; email: string }) {
	const [name, setName] = useState(initialName);
	const [status, setStatus] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setLoading(true);
		setStatus(null);

		const res = await fetch("/api/settings/profile", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		});
		const data = (await res.json()) as { error?: string };
		setLoading(false);

		if (!res.ok) {
			setStatus(data.error ?? "Failed to update name");
			return;
		}

		setStatus("Saved");
	}

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="name">Name</Label>
				<Input id="name" value={name} onChange={(event) => setName(event.target.value)} required />
			</div>
			<div className="space-y-1">
				<Label>Email</Label>
				<p className="text-sm text-neutral-500">{email}</p>
			</div>
			<div className="flex items-center gap-3">
				<Button type="submit" disabled={loading || name.trim() === initialName}>
					{loading ? "Saving..." : "Save"}
				</Button>
				{status && <p className="text-sm text-neutral-500">{status}</p>}
			</div>
		</form>
	);
}
