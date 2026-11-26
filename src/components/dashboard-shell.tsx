"use client";

import { usePathname } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { DashboardNav } from "@/components/dashboard-nav";

const adminPrefixes = ["/admin", "/mailboxes", "/groups", "/domains", "/api-keys", "/activity", "/audit-logs", "/webhooks", "/branding", "/licenses"];

export function DashboardShellNav() {
	const pathname = usePathname();
	const isAdmin = adminPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

	return isAdmin ? <AdminNav /> : <DashboardNav />;
}
