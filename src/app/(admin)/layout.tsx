"use client";

import { SkipToContent } from "@/components/skip-to-content";
import Link from "next/link";
import { HelpCircle, Search } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { AuthGuard } from "@/components/auth/auth-guard";
import { ComposeProvider } from "@/components/compose/compose-context";
import { FloatingComposer } from "@/components/compose/floating-composer";
import { MailboxProvider } from "@/components/mailbox-provider";
import { MailboxSelector } from "@/components/mailbox-selector";
import { LicenseIndicator } from "@/components/license-indicator";
import { AdminNav } from "@/components/admin-nav";
import { SidebarProvider } from "@/components/sidebar-state";
import clsx from "clsx";
import { usePathname } from "next/navigation";
import { adminPageTitles } from "@/components/admin-page-titles";
import { SidebarAside, MobileTopBar } from "@/components/sidebar-aside";
import { SidebarResizeBoundary } from "@/components/sidebar-resize-boundary";
import { ShortcutsProvider } from "@/components/shortcuts";
import { RouteTitle } from "@/components/route-title";

const primaryOnlyPrefixes = [
  "/agent",
  "/api-keys",
  "/webhooks",
  "/spam-filter",
  "/backups",
  "/branding",
  "/licenses",
  "/activity",
  "/audit-logs",
  "/general",
  "/ai-usage",
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useLanguage();
  const pathname = usePathname();
  const requirePrimary = primaryOnlyPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  const mobileTitleKey = adminPageTitles[pathname];
  const mobileTitle = mobileTitleKey ? t(mobileTitleKey) : undefined;

  return (
    <AuthGuard requireMailbox requireRole="admin" requirePrimary={requirePrimary}>
      <SidebarProvider expandedWidth={256} mobileOverlay>
      <MailboxProvider>
        <ComposeProvider>
          <ShortcutsProvider>
            <RouteTitle />
          <div className="grid h-dvh grid-cols-[minmax(0,1fr)] md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)] overflow-hidden bg-[#f6f8fc] transition-[grid-template-columns]" style={{ transitionDuration: "var(--sidebar-transition-duration)" }}>
            <SkipToContent />
            <SidebarAside>
              <div className="h-full">
                <AdminNav />
              </div>
              <SidebarResizeBoundary />
            </SidebarAside>
            <div className="flex min-h-0 min-w-0 flex-col">
                            <MobileTopBar title={mobileTitle} />
              <header className="fixed top-2 right-4 flex items-center gap-4 z-90">
                <LicenseIndicator />
                <MailboxSelector />
              </header>
              <main id="main-content" tabIndex={-1} className={clsx("focus:outline-none page-flush min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain rounded-tl-3xl max-md:rounded-t-3xl max-md:bg-white max-md:pb-24 px-6 py-10 scrollbar-gutter-stable lg:px-12", mobileTitle && "max-md:[&_h1]:sr-only")}>
                <div className="w-full max-w-3xl">{children}</div>
              </main>
            </div>
            <FloatingComposer />
          </div>
          </ShortcutsProvider>
        </ComposeProvider>
      </MailboxProvider>
      </SidebarProvider>
    </AuthGuard>
  );
}
