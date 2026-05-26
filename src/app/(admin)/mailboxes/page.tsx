"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Mail, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Domain, Mailbox } from "./types";
import { getMailboxAddress, getMailboxName } from "./utils";

export default function MailboxesPage() {
	const qc = useQueryClient();
	const [localPart, setLocalPart] = useState("");
	const [domainId, setDomainId] = useState("");
	const [createOpen, setCreateOpen] = useState(false);

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
			setDomainId("");
		},
		onSuccess: () => {
			setCreateOpen(false);
			qc.invalidateQueries({ queryKey: ["mailboxes"] });
		},
	});

	const domainMap = new Map(
		(domains.data?.domains ?? []).map((d) => [d.id, d.hostname]),
	);

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between gap-4">
				<h1 className="text-2xl font-semibold">Mailboxes</h1>
				<Dialog open={createOpen} onOpenChange={setCreateOpen}>
					<DialogTrigger asChild>
						<Button>
							<Plus className="h-4 w-4" />
							New mailbox
						</Button>
					</DialogTrigger>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Create mailbox</DialogTitle>
							<DialogDescription>Add a mailbox and provision its routing rule automatically.</DialogDescription>
						</DialogHeader>
						<div className="space-y-4">
							<div className="space-y-2">
								<Label>Domain</Label>
								<select
									className="w-full h-10 rounded-md border border-neutral-200 px-3 text-sm shadow-sm shadow-neutral-200/50 placeholder:text-neutral-500 focus-visible:outline-none focus-visible:border-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
									value={domainId}
									onChange={(event) => setDomainId(event.target.value)}
								>
									<option value="">Select domain</option>
									{(domains.data?.domains ?? []).map((domain) => (
										<option key={domain.id} value={domain.id}>
											{domain.hostname}
										</option>
									))}
								</select>
							</div>
							<div className="space-y-2 relative">
								<Label>Username</Label>
								<Input
									value={localPart}
									onChange={(event) => setLocalPart(event.target.value)}
									placeholder="support"
								/>
								{domainId && (
									<span className="absolute bottom-2.5 right-4 text-sm text-neutral-400">
										@{domainMap.get(domainId)}
									</span>
								)}
							</div>
							{create.isError && (
								<p className="text-sm text-red-600">{(create.error as Error).message}</p>
							)}
							<Button
								onClick={() => create.mutate()}
								disabled={!domainId || !localPart || create.isPending}
							>
								{create.isPending ? "Creating..." : "Create mailbox"}
							</Button>
						</div>
					</DialogContent>
				</Dialog>
			</div>
			<section className="space-y-3">
				{/* <div className="flex items-center justify-between">
					<span className="text-sm text-neutral-500">
						{(mailboxes.data?.mailboxes ?? []).length} total
					</span>
				</div> */}
				{mailboxes.isLoading && (
					<p className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-500">
						Loading mailboxes...
					</p>
				)}
				{!mailboxes.isLoading && (mailboxes.data?.mailboxes ?? []).length === 0 && (
					<p className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-500">
						No mailboxes yet
					</p>
				)}
				<div className="grid gap-3 md:grid-cols-2">
					{(mailboxes.data?.mailboxes ?? []).map((mailbox) => {
						const mailboxWithHostname = {
							...mailbox,
							hostname: mailbox.hostname ?? domainMap.get(mailbox.domainId) ?? "?",
						};

						return (
							<Link
								key={mailbox.id}
								href={`/mailboxes/${mailbox.id}`}
								className="group flex min-h-24 items-start gap-3 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm shadow-neutral-100 transition hover:border-blue-200 hover:bg-[#f8fbff] hover:shadow-md"
							>
								<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600 group-hover:bg-blue-50 group-hover:text-blue-700">
									<Mail className="h-5 w-5" />
								</span>
								<span className="min-w-0 space-y-1">
									<span className="block truncate text-sm font-semibold text-neutral-900">
										{getMailboxName(mailboxWithHostname)}
									</span>
									<span className="block truncate font-mono text-sm text-neutral-500">
										{getMailboxAddress(mailboxWithHostname)}
									</span>
								</span>
							</Link>
						);
					})}
				</div>
			</section>
		</div>
	);
}
