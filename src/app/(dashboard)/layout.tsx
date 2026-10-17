"use client";

import { SkipToContent } from "@/components/skip-to-content";
import { useEffect } from "react";
import {  Sparkles } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { AuthGuard } from "@/components/auth/auth-guard";
import { ComposeProvider } from "@/components/compose/compose-context";
import { FloatingComposer } from "@/components/compose/floating-composer";
import { MailSearchInput } from "@/components/mail-search/mail-search-input";
import { MailSearchProvider } from "@/components/mail-search/mail-search-context";
import { MailboxProvider } from "@/components/mailbox-provider";
import { MailboxSelector } from "@/components/mailbox-selector";
import { AgentPanel } from "@/components/agent/agent-panel";
import { AssistantOpenContext } from "@/components/agent/assistant-open-state";
import { Button } from "@/components/ui/button";
import { LicenseIndicator } from "@/components/license-indicator";
import { DashboardNav } from "@/components/dashboard-nav";
import { SidebarProvider } from "@/components/sidebar-state";
import { SidebarAside, MobileMenuButton } from "@/components/sidebar-aside";
import { SidebarResizeBoundary } from "@/components/sidebar-resize-boundary";
import { ShortcutsProvider } from "@/components/shortcuts";
import clsx from "clsx";
import { useDashboardState } from "./dashboard-state";
import { useAssistantAvailability } from "./use-assistant-availability";
import { RouteTitle } from "@/components/route-title";
import { useAppBadge } from "@/hooks/use-app-badge";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useLanguage();
  const { assistantOpen, setAssistantOpen, assistantFullSize, setAssistantFullSize } = useDashboardState();
  const assistantEnabled = useAssistantAvailability();
  const assistantVisible = assistantEnabled === true && assistantOpen;
  useAppBadge();

  useEffect(() => {
    if (assistantEnabled === false && (assistantOpen || assistantFullSize)) {
      setAssistantOpen(false);
      setAssistantFullSize(false);
    }
  }, [assistantEnabled, assistantOpen, assistantFullSize, setAssistantOpen, setAssistantFullSize]);

  return (
    <AuthGuard>
      <SidebarProvider mobileOverlay>
        <MailboxProvider>
          <ComposeProvider>
            <MailSearchProvider>
              <ShortcutsProvider>
                <RouteTitle />
                <div className="grid h-dvh grid-cols-[minmax(0,1fr)] overflow-hidden bg-[#f6f8fc] transition-[grid-template-columns] md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]" style={{ transitionDuration: "var(--sidebar-transition-duration)" }}>
                  <SkipToContent />
                  <SidebarAside>
                    <div className="h-full">
                      <DashboardNav />
                    </div>
                    <SidebarResizeBoundary />
                  </SidebarAside>
                  <div className="flex min-h-0 min-w-0 flex-col">
                    <header className="flex h-16 w-full shrink-0 items-center gap-3 pr-4 text-sm">
                      <MobileMenuButton className="ml-2" />
                      <MailSearchInput mobileEnd />
                      {/* <Link
                        href="/settings/account"
                        className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200"
                        title="Account Settings"
                      >
                        <HelpCircle className="h-5 w-5" />
                      </Link> */}
                      <LicenseIndicator />
                      {assistantEnabled && <Button type="button" variant="ghost" size="sm" className={assistantOpen ? "bg-blue-50 text-blue-700" : "text-neutral-600"} onClick={() => { setAssistantOpen((current) => !current); setAssistantFullSize(false); }} aria-label={assistantOpen ? t("agent.assistant.close") : t("agent.assistant.open")} aria-expanded={assistantOpen} aria-controls="email-assistant-panel"><Sparkles className="h-5 w-5" /></Button>}
                      <MailboxSelector />
                    </header>
                    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                      <AssistantOpenContext.Provider value={assistantVisible}>
                        <main id="main-content" tabIndex={-1} className="focus:outline-none min-h-0 min-w-0 flex-1 overflow-y-auto rounded-t-3xl bg-white overscroll-contain scrollbar-gutter-stable" aria-hidden={assistantVisible && assistantFullSize} inert={assistantVisible && assistantFullSize}>
                          {children}
                        </main>
                      </AssistantOpenContext.Provider>
                      <aside className={clsx(assistantFullSize ? "pl-0" : "pl-4", `min-h-0 min-w-0 shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out motion-reduce:transition-none pr-2 pb-2 max-md:p-0`, assistantVisible ? "" : "opacity-0")} style={{ width: assistantVisible ? assistantFullSize ? "100%" : "min(390px, 100%)" : "0px" }} aria-hidden={!assistantVisible} inert={!assistantVisible}>
                        {assistantEnabled && <AgentPanel open={assistantVisible} fullSize={assistantFullSize} onToggleFullSize={() => setAssistantFullSize((current) => !current)} onClose={() => { setAssistantOpen(false); setAssistantFullSize(false); }} />}
                      </aside>
                    </div>
                  </div>
                  <FloatingComposer showButton />
                </div>
              </ShortcutsProvider>
            </MailSearchProvider>
          </ComposeProvider>
        </MailboxProvider>
      </SidebarProvider>
    </AuthGuard>
  );
}
