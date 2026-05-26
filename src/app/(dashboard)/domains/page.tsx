"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Check, X, AlertTriangle, ArrowRight } from "lucide-react";

type Domain = {
	id: string;
	hostname: string;
	status: string;
	routingEnabled: boolean;
	sendingEnabled: boolean;
	zoneId: string;
};

type DnsRecord = { type?: string; name?: string; content?: string; priority?: number };

type DnsStatusSummary = {
	routing: { configured: boolean; missing: string[] };
	sending: { configured: boolean; records: string[] };
};

export default function DomainsPage() {
	const qc = useQueryClient();
	const [hostname, setHostname] = useState("");
	const [dnsView, setDnsView] = useState<{ domain: Domain; dns: unknown } | null>(null);

	const { data, isLoading } = useQuery({
		queryKey: ["domains"],
		queryFn: async () => {
			const res = await fetch("/api/domains?includeDns=true");
			return (await res.json()) as {
				domains: Domain[];
				dns: Record<string, DnsStatusSummary>;
			};
		},
	});

	const create = useMutation({
		mutationFn: async () => {
			const res = await fetch("/api/domains", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ hostname, enableRouting: true, enableSending: true }),
			});
			const json = (await res.json()) as { error?: string };
			if (!res.ok) throw new Error(json.error ?? "Failed");
			return json;
		},
		onSuccess: () => {
			setHostname("");
			qc.invalidateQueries({ queryKey: ["domains"] });
		},
	});

	const remove = useMutation({
		mutationFn: async (id: string) => {
			const res = await fetch(`/api/domains/${id}`, { method: "DELETE" });
			if (!res.ok) throw new Error("Failed to remove");
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["domains"] }),
	});

	const loadDns = async (id: string) => {
		const res = await fetch(`/api/domains/${id}/dns`);
		const json = (await res.json()) as { domain: Domain; dns: unknown };
		if (res.ok) setDnsView(json);
	};

	return (
		<div className="space-y-6 max-w-3xl">
			<h1 className="text-2xl font-semibold">Domains</h1>
			<p className="text-sm text-neutral-500">
				Domains must be on your Cloudflare account. Adding a domain calls the Cloudflare API to enable Email
				Routing (inbound MX/SPF/DKIM) and Email Sending DNS automatically.
			</p>
			<Card>
				<CardHeader>
					<CardTitle>Add domain</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="hostname">Hostname</Label>
						<Input
							id="hostname"
							value={hostname}
							onChange={(e) => setHostname(e.target.value)}
							placeholder="example.com"
						/>
					</div>
					<Button onClick={() => create.mutate()} disabled={!hostname || create.isPending}>
						{create.isPending ? "Adding..." : "Add via Cloudflare API"}
					</Button>
					{create.isError && (
						<p className="text-sm text-red-600">{(create.error as Error).message}</p>
					)}
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Your domains</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					{isLoading && (
						<p className="text-sm text-neutral-500">Loading DNS status...</p>
					)}
					{(data?.domains ?? []).map((d) => {
						const dns = data?.dns?.[d.id];
						return (
							<div
								key={d.id}
								className="flex flex-col gap-2 border-b border-neutral-100 dark:border-neutral-800 pb-3"
							>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<div>
										<span className="font-mono text-sm">{d.hostname}</span>
										<div className="flex gap-2 mt-1">
											<Badge variant={d.status === "active" ? "default" : "secondary"}>
												{d.status}
											</Badge>
											{d.routingEnabled && <Badge variant="outline">routing</Badge>}
											{d.sendingEnabled && <Badge variant="outline">sending</Badge>}
										</div>
									</div>
									<div className="flex gap-2">
										<Button variant="outline" size="sm" onClick={() => loadDns(d.id)}>
											DNS
										</Button>
										<Button
											variant="destructive"
											size="sm"
											onClick={() => remove.mutate(d.id)}
											disabled={remove.isPending}
										>
											Remove
										</Button>
									</div>
								</div>
								{dns && (
									<div className="flex flex-wrap items-center gap-3 text-xs">
										<span className="flex items-center gap-1 text-neutral-500">
											Routing{" "}
											{dns.routing.configured ? (
												<Check className="h-3.5 w-3.5 text-green-600" />
											) : (
												<AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
											)}
										</span>
										{dns.routing.missing.length > 0 && (
											<span className="text-red-600 flex items-center gap-1">
												<X className="h-3 w-3" />
												Missing: {dns.routing.missing.join(", ")}
											</span>
										)}
										<span className="text-neutral-300">|</span>
										<span className="flex items-center gap-1 text-neutral-500">
											Sending{" "}
											{dns.sending.configured ? (
												<Check className="h-3.5 w-3.5 text-green-600" />
											) : (
												<AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
											)}
										</span>
										{dns.sending.records.length > 0 && (
											<span className="text-neutral-500">
												{dns.sending.records.join(", ")}
											</span>
										)}
										<button
											onClick={() => loadDns(d.id)}
											className="flex items-center gap-0.5 text-blue-600 hover:text-blue-800"
										>
											<ArrowRight className="h-3 w-3" />
											details
										</button>
									</div>
								)}
							</div>
						);
					})}
				</CardContent>
			</Card>
			{dnsView && (
				<Card>
					<CardHeader>
						<CardTitle>DNS — {dnsView.domain.hostname}</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4 text-xs font-mono">
						<div>
							<p className="font-sans font-medium text-sm mb-2">Email Routing</p>
							<pre className="overflow-auto bg-neutral-50 dark:bg-neutral-900 p-3 rounded-md">
								{JSON.stringify((dnsView.dns as { routing: unknown }).routing, null, 2)}
							</pre>
						</div>
						<div>
							<p className="font-sans font-medium text-sm mb-2">Email Sending</p>
							<pre className="overflow-auto bg-neutral-50 dark:bg-neutral-900 p-3 rounded-md">
								{JSON.stringify((dnsView.dns as { sending: DnsRecord[] }).sending, null, 2)}
							</pre>
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
