"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Globe2, KeyRound, Mail, PanelLeft, Route, Settings, Webhook } from "lucide-react";
import { cn } from "@/lib/utils";

const links = [
	{ href: "/admin", label: "Overview", icon: Settings },
	{ href: "/mailboxes", label: "Mailboxes", icon: Mail },
	{ href: "/domains", label: "Domains", icon: Globe2 },
	{ href: "/routing", label: "Routing", icon: Route },
	{ href: "/api-keys", label: "API Keys", icon: KeyRound },
	{ href: "/webhooks", label: "Webhooks", icon: Webhook },
	{ href: "/settings", label: "Account", icon: Settings },
];

export function AdminNav({ className }: { className?: string }) {
	const pathname = usePathname();

	return (
		<nav className={cn("flex flex-col gap-1", className)}>
			<Link href="/inbox" className="mb-3 flex h-10 items-center gap-3 px-3 text-neutral-600">
				<PanelLeft className="h-5 w-5" />
				<span className="text-lg font-semibold text-neutral-800">Admin</span>
			</Link>
			{links.map((link) => {
				const Icon = link.icon;
				const active = pathname === link.href || (link.href !== "/admin" && pathname.startsWith(`${link.href}/`));

				return (
					<Link
						key={link.href}
						href={link.href}
						className={cn(
							"flex h-9 items-center gap-3 rounded-r-full px-3 text-sm font-medium text-neutral-700 transition-colors hover:bg-blue-50",
							active && "bg-blue-100 text-blue-900",
						)}
					>
						<Icon className="h-4 w-4" />
						{link.label}
					</Link>
				);
			})}
		</nav>
	);
}
