"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mailbox = { id: string; localPart: string; displayName: string | null; domainId: string };
type Domain = { id: string; hostname: string };

export default function MailboxesPage() {
	const qc = useQueryClient();
	const [localPart, setLocalPart] = useState("");
	const [domainId, setDomainId] = useState("");

	const domains = useQuery({
		queryKey: ["domains"],
		queryFn: async () => {
			const res = await fetch("/api/domains");
			return (await res.json()) as { domains: Domain[] };
		},
	});

	const mailboxes = useQuery({
		queryKey: ["mailboxes"],
		queryFn: async () => {
			const res = await fetch("/api/mailboxes");
			return (await res.json()) as { mailboxes: Mailbox[] };
		},
	});

	const create = useMutation({
		mutationFn: async () => {
			const res = await fetch("/api/mailboxes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ domainId, localPart, displayName: localPart }),
			});
			const json = (await res.json()) as { error?: string };
			if (!res.ok) throw new Error(json.error ?? "Failed");
			setLocalPart("");
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mailboxes"] }),
	});

	const domainMap = new Map((domains.data?.domains ?? []).map((d) => [d.id, d.hostname]));

	return (
		<div className="space-y-6 max-w-2xl">
			<h1 className="text-2xl font-semibold">Mailboxes</h1>
			<Card>
				<CardHeader>
					<CardTitle>Create mailbox</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2">
						<Label>Domain</Label>
						<select
							className="w-full h-10 rounded-md border border-neutral-200 dark:border-neutral-800 px-3 text-sm"
							value={domainId}
							onChange={(e) => setDomainId(e.target.value)}
						>
							<option value="">Select domain</option>
							{(domains.data?.domains ?? []).map((d) => (
								<option key={d.id} value={d.id}>
									{d.hostname}
								</option>
							))}
						</select>
					</div>
					<div className="space-y-2">
						<Label>Local part</Label>
						<Input value={localPart} onChange={(e) => setLocalPart(e.target.value)} placeholder="support" />
					</div>
					<Button onClick={() => create.mutate()} disabled={!domainId || !localPart || create.isPending}>
						Create mailbox
					</Button>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Addresses</CardTitle>
				</CardHeader>
				<CardContent className="space-y-2 font-mono text-sm">
					{(mailboxes.data?.mailboxes ?? []).map((m) => (
						<p key={m.id}>
							{m.localPart}@{domainMap.get(m.domainId) ?? "?"}
						</p>
					))}
				</CardContent>
			</Card>
		</div>
	);
}
