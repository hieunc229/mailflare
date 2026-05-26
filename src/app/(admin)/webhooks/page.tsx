"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function WebhooksPage() {
	const qc = useQueryClient();
	const [url, setUrl] = useState("");
	const [secret, setSecret] = useState<string | null>(null);

	const { data } = useQuery({
		queryKey: ["webhooks"],
		queryFn: async () => {
			const res = await fetch("/api/webhooks");
			return (await res.json()) as { webhooks: { id: string; url: string }[] };
		},
	});

	const create = useMutation({
		mutationFn: async () => {
			const res = await fetch("/api/webhooks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					url,
					events: ["message.inbound", "message.outbound", "message.failed"],
				}),
			});
			const json = (await res.json()) as { secret?: string };
			if (!res.ok) throw new Error("Failed");
			setSecret(json.secret ?? null);
			setUrl("");
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks"] }),
	});

	return (
		<div className="space-y-6 max-w-2xl">
			<h1 className="text-2xl font-semibold">Webhooks</h1>
			{secret && (
				<Card>
					<CardContent className="pt-6 text-sm">
						<p>Signing secret:</p>
						<code className="block mt-1 text-xs break-all">{secret}</code>
					</CardContent>
				</Card>
			)}
			<Card>
				<CardHeader>
					<CardTitle>Add webhook</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2">
						<Label>URL</Label>
						<Input value={url} onChange={(e) => setUrl(e.target.value)} />
					</div>
					<Button onClick={() => create.mutate()} disabled={!url || create.isPending}>
						Add
					</Button>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Endpoints</CardTitle>
				</CardHeader>
				<CardContent className="text-sm font-mono space-y-1">
					{(data?.webhooks ?? []).map((w) => (
						<p key={w.id} className="truncate">
							{w.url}
						</p>
					))}
				</CardContent>
			</Card>
		</div>
	);
}
