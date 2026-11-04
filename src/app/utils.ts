import { FileText, Inbox, MailCheck, Send, ShieldAlert, Trash2 } from "@/components/icons";
import type { HomeAction, LandingNavItem, LandingStat, MailPreview, SidebarItem } from "./types";

export const landingNavItems: LandingNavItem[] = [
	{ href: "#workflow", label: "Workflow" },
	{ href: "#domains", label: "Domains" },
	{ href: "#api", label: "API" },
];

export const sidebarItems: SidebarItem[] = [
	{ labelKey: "navigation.inbox", icon: Inbox, active: true, count: "18" },
	{ labelKey: "navigation.sent", icon: Send },
	{ labelKey: "navigation.drafts", icon: FileText, count: "4" },
	{ labelKey: "navigation.spam", icon: ShieldAlert },
	{ labelKey: "navigation.trash", icon: Trash2 },
];

export const heroMessages: MailPreview[] = [
	{
		icon: MailCheck,
		sender: "postmaster@northline.dev",
		subjectKey: "home.msg1.subject",
		previewKey: "home.msg1.preview",
		badgeKey: "home.msg1.badge",
	},
	{
		icon: MailCheck,
		sender: "ops@halcyon.tools",
		subjectKey: "home.msg2.subject",
		previewKey: "home.msg2.preview",
		badgeKey: "home.msg2.badge",
	},
	{
		icon: MailCheck,
		sender: "alerts@marketmesh.io",
		subjectKey: "home.msg3.subject",
		previewKey: "home.msg3.preview",
		badgeKey: "home.msg3.badge",
	},
	{
		icon: MailCheck,
		sender: "admin@mailflare.dev",
		subjectKey: "home.msg4.subject",
		previewKey: "home.msg4.preview",
		badgeKey: "home.msg4.badge",
	},
];

export const inboxStats: LandingStat[] = [
	{ value: "24ms", label: "routing rule lookup" },
	{ value: "7", label: "active domains" },
	{ value: "1.8k", label: "messages tracked this week" },
];

export const deliverySignals = [
	"DNS setup status before mail starts moving",
	"Mailbox-first routing for support and product teams",
	"API keys and webhooks managed beside the inbox",
];

export function getHomeActions(isLoggedIn: boolean): HomeAction[] {
	if (isLoggedIn) {
		return [{ href: "/inbox", labelKey: "home.dashboard", variant: "default" }];
	}

	return [
		{ href: "/login", labelKey: "home.logIn", variant: "outline" },
		{ href: "/setup", labelKey: "home.createAccount", variant: "default" },
	];
}
