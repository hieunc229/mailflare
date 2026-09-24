"use client";

import Link from "next/link";
import { HelpCircle } from "lucide-react";
import { AuthGuard } from "@/components/auth/auth-guard";
import { ComposeProvider } from "@/components/compose/compose-context";
import { FloatingComposer } from "@/components/compose/floating-composer";
import { MailSearchInput } from "@/components/mail-search/mail-search-input";
import { MailSearchProvider } from "@/components/mail-search/mail-search-context";
import { MailboxProvider } from "@/components/mailbox-provider";
import { MailboxSelector } from "@/components/mailbox-selector";
import { LicenseIndicator } from "@/components/license-indicator";
import { DashboardNav } from "@/components/dashboard-nav";
import { SidebarProvider } from "@/components/sidebar-state";
import { ShortcutsProvider } from "@/components/shortcuts";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <SidebarProvider>
      <MailboxProvider>
        <ComposeProvider>
          <MailSearchProvider>
            <ShortcutsProvider>
            <div className="grid h-[100dvh] grid-cols-[72px_minmax(0,1fr)] md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)] overflow-hidden bg-[#f6f8fc] transition-[grid-template-columns] duration-200">
              <aside className="z-30 w-[var(--sidebar-width)] min-h-0 bg-[#f6f8fc] overflow-y-auto overscroll-contain px-3 py-4 [scrollbar-gutter:stable]">
                <DashboardNav />
              </aside>
              <div className="flex min-h-0 min-w-0 flex-col">
                <header className="flex h-16 w-full shrink-0 items-center gap-4 pr-4 text-sm">
                  <MailSearchInput />
                  <Link
                    href="/settings/account"
                    className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200"
                  >
                    <HelpCircle className="h-5 w-5" />
                  </Link>
                  <LicenseIndicator />
                  <MailboxSelector />
                </header>
                <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-stable">
                  {children}
                </main>
              </div>
              <FloatingComposer />
            </div>
            </ShortcutsProvider>
          </MailSearchProvider>
        </ComposeProvider>
      </MailboxProvider>
      </SidebarProvider>
    </AuthGuard>
  );
}
