"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Globe2,
  KeyRound,
  Mail,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { NavItem } from "./components-nav";

const links = [
  { href: "/admin", label: "Overview", icon: Settings },
  { href: "/mailboxes", label: "Mailboxes", icon: Mail },
  { href: "/domains", label: "Domains", icon: Globe2 },
  { href: "/api-keys", label: "API Keys", icon: KeyRound },
  // { href: "/webhooks", label: "Webhooks", icon: Webhook }
];

export function AdminNav({ className }: { className?: string }) {
  const pathname = usePathname();

  return (
    <nav className={cn("flex flex-col gap-1", className)}>
      <Link
        href="/inbox"
        className="mb-3 flex h-10 items-center gap-3 px-3 text-neutral-600"
      >
        <img src="/icon-96.png" height={28} width={28} />
        <span className="text-lg font-semibold text-neutral-800">Admin</span>
      </Link>
      {links.map((link) =>  <NavItem link={link} key={link.href} />)}
    </nav>
  );
}
