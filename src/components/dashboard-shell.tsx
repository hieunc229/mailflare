"use client";

import { usePathname } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { DashboardNav } from "@/components/dashboard-nav";

const adminPrefixes = ["/admin", "/mailboxes", "/domains", "/routing", "/api-keys", "/webhooks"];

export function DashboardShellNav() {
	const pathname = usePathname();
	const isAdmin = adminPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

	return isAdmin ? <AdminNav /> : <DashboardNav />;
}
