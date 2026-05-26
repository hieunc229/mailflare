"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function RoutingPage() {
	const qc = useQueryClient();
	const [pattern, setPattern] = useState("*");
	const [domainId, setDomainId] = useState("");

	const domains = useQuery({
		queryKey: ["domains"],
		queryFn: async () => {
			const res = await fetch("/api/domains");
			return (await res.json()) as { domains: { id: string; hostname: string }[] };
		},
	});

	const rules = useQuery({
		queryKey: ["routing-rules"],
		queryFn: async () => {
			const res = await fetch("/api/routing-rules");
			return (await res.json()) as { rules: { id: string; pattern: string; action: string }[] };
		},
	});

	const create = useMutation({
		mutationFn: async () => {
			const res = await fetch("/api/routing-rules", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ domainId, pattern, action: "store", priority: 10 }),
			});
			if (!res.ok) throw new Error("Failed");
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["routing-rules"] }),
	});

	return (
		<div className="space-y-6 max-w-2xl">
			<h1 className="text-2xl font-semibold">Routing rules</h1>
			<Card>
				<CardHeader>
					<CardTitle>Add rule</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2">
						<Label>Domain</Label>
						<select
							className="w-full h-10 rounded-md border border-neutral-200 px-3 text-sm"
							value={domainId}
							onChange={(e) => setDomainId(e.target.value)}
						>
							<option value="">Select</option>
							{(domains.data?.domains ?? []).map((d) => (
								<option key={d.id} value={d.id}>
									{d.hostname}
								</option>
							))}
						</select>
					</div>
					<div className="space-y-2">
						<Label>Pattern</Label>
						<Input value={pattern} onChange={(e) => setPattern(e.target.value)} />
					</div>
					<Button onClick={() => create.mutate()} disabled={!domainId || create.isPending}>
						Add
					</Button>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Rules</CardTitle>
				</CardHeader>
				<CardContent className="text-sm font-mono space-y-1">
					{(rules.data?.rules ?? []).map((r) => (
						<p key={r.id}>
							{r.pattern} → {r.action}
						</p>
					))}
				</CardContent>
			</Card>
		</div>
	);
}
