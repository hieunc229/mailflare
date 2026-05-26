"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileText, Inbox, MailPlus, PanelLeft, Send, Settings, ShieldAlert, Trash2 } from "lucide-react";
import { useCompose } from "@/components/compose/compose-context";
import { cn } from "@/lib/utils";

const links = [
  { href: "/compose", label: "Compose", icon: MailPlus, primary: true },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/sent", label: "Sent", icon: Send },
  { href: "/drafts", label: "Drafts", icon: FileText },
  { href: "/spam", label: "Spam", icon: ShieldAlert },
  { href: "/trash", label: "Trash", icon: Trash2 },
  { break: true },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function DashboardNav({ className }: { className?: string }) {
  const pathname = usePathname();
  const { openComposer } = useCompose();

  return (
    <nav className={cn("flex flex-col gap-1 flex-1", className)}>
      <Link href="/inbox" className="mb-3 flex h-10 items-center gap-3 px-3 text-neutral-600">
        <PanelLeft className="h-5 w-5" />
        <span className="text-lg font-semibold text-neutral-800">Mail</span>
      </Link>
      {links.map((link, i) => {
        if (!link.href) {
          return <span key={`break-${i}`} className="flex-1" />;
        }
        const Icon = link.icon;
        const active =
          pathname === link.href || pathname.startsWith(`${link.href}/`);
        const classes = cn(
          "flex h-9 items-center gap-3 rounded-r-full text-sm font-medium text-neutral-700 transition-colors hover:bg-blue-50",
          active && "bg-blue-100 text-blue-900",
          link.primary &&
            "mb-3 h-12 w-fit rounded-2xl bg-blue-100 px-5 text-blue-950 shadow-sm hover:bg-blue-200",
        );

        if (link.href === "/compose") {
          return (
            <button key={link.href} type="button" onClick={openComposer} className={classes}>
              <Icon className="h-4 w-4" />
              {link.label}
            </button>
          );
        }

        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn("-ml-3 pl-6",classes)}
          >
            <Icon className="h-4 w-4" />
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
