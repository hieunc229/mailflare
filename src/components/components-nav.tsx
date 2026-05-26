
import Link from "next/link";

import { cn } from "@/lib/utils";
import { usePathname } from "next/navigation";
import { useCompose } from "./compose/compose-context";

export function NavItem({ link }:{ link: any }) {
  const pathname = usePathname();
  const { openComposer } = useCompose();

  if (!link.href) {
    return <span className="flex-1" />;
  }

  const Icon = link.icon;
  const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
  const classes = cn(
    "flex h-9 items-center gap-3 rounded-r-full text-sm font-medium text-neutral-700 transition-colors hover:bg-blue-50",
    active && "bg-blue-100 text-blue-900",
    link.primary &&
      "mb-3 h-12 w-fit rounded-2xl bg-blue-100 px-5 text-blue-950 shadow-sm hover:bg-blue-200",
  );

  if (link.href === "/compose") {
    return (
      <button
        type="button"
        onClick={openComposer}
        className={classes}
      >
        <Icon className="h-4 w-4" />
        <span className="flex-1">{link.label}</span>
        {typeof link.count === "number" && link.count > 0 && (
          <span className="ml-auto mr-3 rounded-full px-2 py-0.5 text-sm font-semibold text-neutral-700">
            {link.count > 99 ? "99+" : link.count}
          </span>
        )}
      </button>
    );
  }

  return (
    <Link
      href={link.href}
      className={cn("-ml-3 pl-6", classes)}
    >
      <Icon className="h-4 w-4" />
      <span className="flex-1">{link.label}</span>
      {typeof link.count === "number" && link.count > 0 && (
        <span className="ml-auto mr-3 rounded-full px-2 py-0.5 text-sm font-semibold text-neutral-700">
          {link.count > 99 ? "99+" : link.count}
        </span>
      )}
    </Link>
  );
}
