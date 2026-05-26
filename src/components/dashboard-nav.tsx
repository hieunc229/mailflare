"use client";

import Link from "next/link";
import {
  FileText,
  Inbox,
  MailPlus,
  Send,
  Settings,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { cn } from "@/lib/utils";
import { NavItem } from "./components-nav";
import { getFolderNavCount } from "./dashboard-nav-utils";

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
  const { selectedMailbox } = useSelectedMailbox();
  const { counts } = useMessageCounts(selectedMailbox?.id);
  const linksWithCounts = links.map((link) => {
    if (link.href === "/inbox") return { ...link, count: getFolderNavCount("inbox", counts.folders) };
    if (link.href === "/sent") return { ...link, count: getFolderNavCount("sent", counts.folders) };
    if (link.href === "/drafts") return { ...link, count: getFolderNavCount("drafts", counts.folders) };
    if (link.href === "/spam") return { ...link, count: getFolderNavCount("spam", counts.folders) };
    if (link.href === "/trash") return { ...link, count: getFolderNavCount("trash", counts.folders) };
    return link;
  });

  return (
    <nav className={cn("flex flex-col gap-1 flex-1", className)}>
      <Link
        href="/inbox"
        className="mb-3 flex h-10 items-center gap-3 px-3 text-neutral-600"
      >
        <img src="/icon-96.png" height={28} width={28} />
        <span className="text-lg font-semibold text-neutral-800">Mail</span>
      </Link>
      {linksWithCounts.map((link, i) => <NavItem link={link} key={`nav-${link.href || i}`} />)}
    </nav>
  );
}
