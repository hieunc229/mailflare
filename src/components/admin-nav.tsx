"use client";

import {
  DatabaseBackup,
  Globe2,
  Activity,
  Mail,
  Settings,
  Palette,
  BadgeDollarSign,
  Users,
  Route,
  Webhook,
  KeyRound,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "./language-provider";
import type { TranslationKey } from "@/lib/i18n/types";
import type { NavLink } from "./components-nav-types";
import { useCurrentUser } from "@/hooks/use-current-user";
import { NavItem } from "./components-nav";
import { NavSectionHeader, useSectionOpen } from "./nav-section-header";
import { SidebarFooter } from "./sidebar-footer";
import { SidebarHeader } from "./sidebar-header";
import { SidebarScaffold } from "./sidebar-scaffold";
import { useSidebar } from "./sidebar-state";

type AdminLinkPermission = "primary" | "domains" | "users";

type AdminNavLink = {
  href: string;
  labelKey: TranslationKey;
  icon: typeof Settings;
  permission?: AdminLinkPermission;
};

// `id` names a section for its remembered open/closed state; it is not shown.
const sections: { id?: string; labelKey?: TranslationKey; links: AdminNavLink[] }[] = [
  {
    // label: "Overview",
    links: [{ href: "/admin", labelKey: "admin.nav.overview", icon: Settings }],
  },
  {
    id: "Email",
    labelKey: "admin.nav.email",
    links: [
      { href: "/mailboxes", labelKey: "admin.nav.mailboxes", icon: Mail },
      { href: "/domains", labelKey: "admin.nav.domains", icon: Globe2, permission: "domains" },
      { href: "/routing", labelKey: "admin.nav.routing", icon: Route, permission: "domains" },
      { href: "/webhooks", labelKey: "admin.nav.webhooks", icon: Webhook, permission: "primary" },
    ],
  },
  {
    id: "Administration",
    labelKey: "admin.nav.administration",
    links: [
      { href: "/api-keys", labelKey: "admin.nav.apiKeys", icon: KeyRound, permission: "primary" },
      { href: "/general", labelKey: "admin.nav.general", icon: Settings, permission: "primary" },
      { href: "/agent", labelKey: "admin.nav.agent", icon: Bot, permission: "primary" },
      { href: "/accounts", labelKey: "admin.nav.accounts", icon: Users },
      { href: "/activity", labelKey: "admin.nav.activity", icon: Activity, permission: "primary" },
      { href: "/backups", labelKey: "admin.nav.backups", icon: DatabaseBackup, permission: "primary" },
    ],
  },
  {
    id: "Product",
    labelKey: "admin.nav.product",
    links: [
      { href: "/branding", labelKey: "admin.nav.branding", icon: Palette, permission: "primary" },
      { href: "/licenses", labelKey: "admin.nav.licenses", icon: BadgeDollarSign, permission: "primary" },
    ],
  },
];

function AdminSection({ id, label, links, showDivider, minimal }: { id?: string; label?: string; links: NavLink[]; showDivider: boolean; minimal: boolean }) {
  const [open, toggle] = useSectionOpen(`mailflare:nav:admin-section-open:${id ?? ""}`);
  // Unlabelled sections have nothing to toggle; the icon rail always shows everything.
  const expanded = minimal || !label || open;
  return (
    <section>
      {showDivider && <hr className="mx-6 mb-3 border-neutral-200/70" />}
      {!minimal && label && <NavSectionHeader label={label} open={open} onToggle={toggle} />}
      {expanded && (
        <div className="space-y-px">
          {links.map((link) => (
            <NavItem link={link} key={link.href} />
          ))}
        </div>
      )}
    </section>
  );
}

export function AdminNav({ className }: { className?: string }) {
  const { t } = useLanguage();
  const { minimal } = useSidebar();
  const user = useCurrentUser();

  function canSee(link: AdminNavLink): boolean {
    if (!link.permission) return true;
    if (!user) return false;
    if (link.permission === "primary") return user.isPrimaryAdmin;
    if (link.permission === "domains") return user.isPrimaryAdmin || user.canManageDomains;
    return user.isPrimaryAdmin || user.canManageUsers;
  }

  return (
    <SidebarScaffold className={className} header={<SidebarHeader href="/inbox" label={t("account.admin")} />} footer={<SidebarFooter />}>
      <div className={cn("space-y-4", minimal && "space-y-2 pl-1")}>
        {sections.map((section, sectionIndex) => {
          const links = section.links.filter(canSee).map(({ labelKey, ...link }): NavLink => ({ ...link, label: t(labelKey) }));
          if (links.length === 0) return null;

          return (
            // The first section has no label, so fall back to its first href for a stable key.
            <AdminSection key={section.id ?? links[0].href} id={section.id} label={section.labelKey ? t(section.labelKey) : undefined} links={links} showDivider={minimal && sectionIndex > 0} minimal={minimal} />
          );
        })}
      </div>
    </SidebarScaffold>
  );
}
