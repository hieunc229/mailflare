import { FileText, Inbox, MailCheck, Send, ShieldAlert, Trash2 } from "lucide-react";
import type { HomeAction, LandingNavItem, LandingStat, MailPreview, SidebarItem } from "./types";

export const landingNavItems: LandingNavItem[] = [
	{ href: "#workflow", label: "Workflow" },
	{ href: "#domains", label: "Domains" },
	{ href: "#api", label: "API" },
];

export const sidebarItems: SidebarItem[] = [
	{ label: "Inbox", icon: Inbox, active: true, count: "18" },
	{ label: "Sent", icon: Send },
	{ label: "Drafts", icon: FileText, count: "4" },
	{ label: "Spam", icon: ShieldAlert },
	{ label: "Trash", icon: Trash2 },
];

export const heroMessages: MailPreview[] = [
	{
		icon: MailCheck,
		sender: "postmaster@northline.dev",
		subject: "Route matched",
		preview: "Inbound mail was delivered to support after DNS validation.",
		badge: "Inbound",
	},
	{
		icon: MailCheck,
		sender: "ops@halcyon.tools",
		subject: "API send accepted",
		preview: "Message queued through the production API key.",
		badge: "Sent",
	},
	{
		icon: MailCheck,
		sender: "alerts@marketmesh.io",
		subject: "Webhook delivered",
		preview: "Event payload reached your billing workspace endpoint.",
		badge: "Hook",
	},
	{
		icon: MailCheck,
		sender: "admin@lumal.email",
		subject: "Mailbox provisioned",
		preview: "New routing mailbox is ready for customer replies.",
		badge: "Admin",
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
		return [{ href: "/inbox", label: "Dashboard", variant: "default" }];
	}

	return [
		{ href: "/login", label: "Log in", variant: "outline" },
		{ href: "/register", label: "Create account", variant: "default" },
	];
}
