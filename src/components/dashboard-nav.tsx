"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FileText,
  Inbox,
  MailPlus,
  PanelLeft,
  Send,
  Settings,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useCompose } from "@/components/compose/compose-context";
import { cn } from "@/lib/utils";
import { NavItem } from "./components-nav";

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
      <Link
        href="/inbox"
        className="mb-3 flex h-10 items-center gap-3 px-3 text-neutral-600"
      >
        <img src="/icon-96.png" height={28} width={28} />
        <span className="text-lg font-semibold text-neutral-800">Mail</span>
      </Link>
      {links.map((link, i) => <NavItem link={link} key={`nav-${link.href || i}`} />)}
    </nav>
  );
}
