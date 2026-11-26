"use client";

import Link from "next/link";
import { BadgeDollarSign, Bot, Building2, Globe2, KeyRound, Mail, Palette, Users } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import type { TranslationKey } from "@/lib/i18n/types";
import { AdminUpdateCard } from "@/components/admin-update-card";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useCurrentUser } from "@/hooks/use-current-user";

type AdminSection = {
	href: string;
	titleKey?: TranslationKey;
	descriptionKey?: TranslationKey;
	/** Plain text for cards that exist only on a hosted workspace (not in the translation files). */
	title?: string;
	description?: string;
	hostedOnly?: boolean;
	icon: typeof Bot;
	permission?: "primary" | "domains" | "users";
};

const sections: AdminSection[] = [
	{
		href: "/workspace",
		title: "Workspace",
		description: "Name, address, plan and billing of this workspace.",
		icon: Building2,
		permission: "primary",
		hostedOnly: true,
	},
	{
		href: "/agent",
		titleKey: "admin.nav.agent",
		descriptionKey: "admin.section.agent",
		icon: Bot,
		permission: "primary",
	},
	{
		href: "/mailboxes",
		titleKey: "admin.nav.mailboxes",
		descriptionKey: "admin.section.mailboxes",
		icon: Mail,
	},
	{
		href: "/domains",
		titleKey: "admin.nav.domains",
		descriptionKey: "admin.section.domains",
		icon: Globe2,
		permission: "domains",
	},
	{
		href: "/branding",
		titleKey: "admin.nav.branding",
		descriptionKey: "admin.section.branding",
		icon: Palette,
		permission: "primary",
	},
	{
		href: "/licenses",
		titleKey: "admin.nav.licenses",
		descriptionKey: "admin.section.licenses",
		icon: BadgeDollarSign,
		permission: "primary",
	},
	{
		href: "/accounts",
		titleKey: "admin.nav.accounts",
		descriptionKey: "admin.section.accounts",
		icon: Users,
	},
	{
		href: "/api-keys",
		titleKey: "admin.section.apiKeysTitle",
		descriptionKey: "admin.section.apiKeys",
		icon: KeyRound,
		permission: "primary",
	},
	// {
	// 	href: "/webhooks",
	// 	title: "Webhooks",
	// 	description: "Send mail events to external systems.",
	// 	icon: Webhook,
	// },
	// {
	// 	href: "/settings/account",
	// 	title: "Account",
	// 	description: "View personal account and platform configuration.",
	// 	icon: Settings,
	// },
];

export default function AdminSettingsPage() {
	const { t } = useLanguage();
	const user = useCurrentUser();

	function canSee(section: AdminSection): boolean {
		// A hosted workspace's licensing is its plan, not something the admin manages.
		if (section.hostedOnly && !user?.managed) return false;
		if (user?.managed && section.href === "/licenses") return false;
		if (!section.permission) return true;
		if (!user) return false;
		if (section.permission === "primary") return user.isPrimaryAdmin;
		if (section.permission === "domains") return user.isPrimaryAdmin || user.canManageDomains;
		return user.isPrimaryAdmin || user.canManageUsers;
	}

	return (
		<div>
			<div className="mb-8">
				<h1 className="text-2xl md:text-3xl font-medium text-neutral-900">{t("admin.title")}</h1>
				<p className="mt-2 text-sm text-neutral-500">
					{t("admin.description")}
				</p>
			</div>
			<div className="grid lg:grid-cols-2 gap-4">
				{sections.filter(canSee).map((section) => {
					const Icon = section.icon;

					return (
						<Link key={section.href} href={section.href}>
							<Card className="h-full rounded-3xl border-0 bg-white p-6 transition-colors hover:bg-blue-50/60">
								<CardHeader className="flex-row items-center gap-4 space-y-0 py-0">
									<div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-700">
										<Icon className="h-5 w-5" />
									</div>
									<h2 className="text-base font-semibold leading-none">{section.title ?? t(section.titleKey!)}</h2>
								</CardHeader>
								<CardContent className="pt-4">
									<p className="text-sm text-neutral-500">{section.description ?? t(section.descriptionKey!)}</p>
								</CardContent>
							</Card>
						</Link>
					);
				})}
			</div>
			{user?.isPrimaryAdmin && !user.managed && (
				<div className="mt-8">
					<AdminUpdateCard />
				</div>
			)}
		</div>
	);
}
