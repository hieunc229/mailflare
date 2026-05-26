"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ApiKey = { id: string; name: string; prefix: string; scopes: string };

export default function ApiKeysPage() {
	const qc = useQueryClient();
	const [name, setName] = useState("");
	const [newKey, setNewKey] = useState<string | null>(null);

	const { data } = useQuery({
		queryKey: ["api-keys"],
		queryFn: async () => {
			const res = await fetch("/api/api-keys");
			return (await res.json()) as { apiKeys: ApiKey[] };
		},
	});

	const create = useMutation({
		mutationFn: async () => {
			const res = await fetch("/api/api-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, scopes: ["send", "read"] }),
			});
			const json = (await res.json()) as { key?: string };
			if (!res.ok) throw new Error("Failed");
			setNewKey(json.key ?? null);
			setName("");
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
	});

	return (
		<div className="space-y-6 max-w-2xl">
			<h1 className="text-2xl font-semibold">API Keys</h1>
			{newKey && (
				<Card className="border-amber-300 bg-amber-50 dark:bg-amber-950">
					<CardContent className="pt-6">
						<p className="text-sm font-medium">Copy your key now:</p>
						<code className="block mt-2 text-xs break-all">{newKey}</code>
					</CardContent>
				</Card>
			)}
			<Card>
				<CardHeader>
					<CardTitle>Create key</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2">
						<Label>Name</Label>
						<Input value={name} onChange={(e) => setName(e.target.value)} />
					</div>
					<Button onClick={() => create.mutate()} disabled={!name || create.isPending}>
						Create
					</Button>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Keys</CardTitle>
				</CardHeader>
				<CardContent className="space-y-2 text-sm">
					{(data?.apiKeys ?? []).map((k) => (
						<div key={k.id} className="flex justify-between">
							<span>
								{k.name} · <code>{k.prefix}…</code>
							</span>
							<span className="text-neutral-500">{k.scopes}</span>
						</div>
					))}
				</CardContent>
			</Card>
		</div>
	);
}
