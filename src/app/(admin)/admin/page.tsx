import Link from "next/link";
import { Globe2, KeyRound, Mail, Settings, Webhook } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const sections = [
	{
		href: "/mailboxes",
		title: "Mailboxes",
		description: "Create and manage mailbox addresses.",
		icon: Mail,
	},
	{
		href: "/domains",
		title: "Domains",
		description: "Add Cloudflare domains and inspect DNS state.",
		icon: Globe2,
	},
	{
		href: "/api-keys",
		title: "API Keys",
		description: "Manage API credentials for programmatic access.",
		icon: KeyRound,
	},
	{
		href: "/webhooks",
		title: "Webhooks",
		description: "Send mail events to external systems.",
		icon: Webhook,
	},
	{
		href: "/settings",
		title: "Account",
		description: "View personal account and platform configuration.",
		icon: Settings,
	},
];

export default function AdminSettingsPage() {
	return (
		<div className="h-full overflow-auto">
			<div className="mb-8">
				<h1 className="text-2xl font-normal text-neutral-900">Admin settings</h1>
				<p className="mt-2 text-sm text-neutral-500">
					Manage workspace-level mail infrastructure and integrations.
				</p>
			</div>
			<div className="grid max-w-5xl gap-4 md:grid-cols-2">
				{sections.map((section) => {
					const Icon = section.icon;

					return (
						<Link key={section.href} href={section.href}>
							<Card className="h-full transition-shadow hover:shadow-md">
								<CardHeader className="flex-row items-center gap-4 space-y-0">
									<div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-700">
										<Icon className="h-5 w-5" />
									</div>
									<CardTitle className="text-base">{section.title}</CardTitle>
								</CardHeader>
								<CardContent>
									<p className="text-sm text-neutral-500">{section.description}</p>
								</CardContent>
							</Card>
						</Link>
					);
				})}
			</div>
		</div>
	);
}
