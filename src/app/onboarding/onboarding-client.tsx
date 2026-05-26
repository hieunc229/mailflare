"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, MailPlus } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createDomain, createMailbox, getDomains } from "./utils";

export function OnboardingClient() {
	const router = useRouter();
	const [step, setStep] = useState<1 | 2>(1);
	const [hostname, setHostname] = useState("");
	const [domainId, setDomainId] = useState("");
	const [localPart, setLocalPart] = useState("me");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		void getDomains()
			.then((data) => {
				const primary = data.domains?.[0];
				if (!primary) return;
				setDomainId(primary.id);
				setHostname(primary.hostname);
				setStep(2);
			})
			.catch(() => undefined);
	}, []);

	async function addDomain() {
		setLoading(true);
		setError(null);

		const { ok, data } = await createDomain(hostname);
		setLoading(false);
		if (!ok || !data.domain) {
			setError(data.error ?? "Failed to add domain");
			return;
		}
		setDomainId(data.domain.id);
		setStep(2);
	}

	async function addMailbox() {
		setLoading(true);
		setError(null);

		const { ok, data } = await createMailbox(domainId, localPart);
		setLoading(false);
		if (!ok) {
			setError(data.error ?? "Failed to create mailbox");
			return;
		}
		router.push("/inbox");
	}

	return (
		<AuthShell
			icon={MailPlus}
			title={step === 1 ? "Connect mail routing" : "Create your first mailbox"}
			description={
				step === 1
					? "Add the Cloudflare domain that will receive and send mail through this workspace."
					: "Choose the mailbox address that should open directly into the inbox."
			}
			steps={[
				{ label: "Domain", active: step === 1 },
				{ label: "Mailbox", active: step === 2 },
			]}
			footer={
				<span className="inline-flex items-center gap-2 text-neutral-500">
					Setup completes in the inbox
					<ArrowRight className="h-4 w-4" />
				</span>
			}
		>
			<div className="space-y-5">
				{step === 1 && (
					<>
						<p className="rounded-2xl bg-[#eaf1fb] px-4 py-3 text-sm leading-6 text-neutral-700">
							Your domain must use Cloudflare DNS on the same account as{" "}
							<code className="font-mono text-xs font-semibold text-blue-800">CF_TOKEN</code>.
						</p>
						<div className="space-y-2">
							<Label htmlFor="domain">Domain</Label>
							<Input
								id="domain"
								value={hostname}
								onChange={(e) => setHostname(e.target.value)}
								placeholder="example.com"
							/>
						</div>
						<Button
							onClick={addDomain}
							disabled={!hostname || loading}
							className="h-11 w-full rounded-full px-6 active:scale-[0.98]"
						>
							{loading ? "Adding..." : "Add domain"}
						</Button>
					</>
				)}
				{step === 2 && (
					<>
						<div className="space-y-2">
							<Label htmlFor="localPart">Mailbox address</Label>
							<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
								<Input
									id="localPart"
									value={localPart}
									onChange={(e) => setLocalPart(e.target.value)}
									className="min-w-0"
								/>
								<span className="max-w-36 truncate text-sm font-medium text-neutral-500">@{hostname}</span>
							</div>
						</div>
						<Button
							onClick={addMailbox}
							disabled={!localPart || loading}
							className="h-11 w-full rounded-full px-6 active:scale-[0.98]"
						>
							{loading ? "Creating..." : "Go to inbox"}
						</Button>
					</>
				)}
				{error && (
					<p className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
						{error}
					</p>
				)}
			</div>
		</AuthShell>
	);
}
