import Link from "next/link";
import type { DragEvent } from "react";
import { useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { usePathname, useRouter } from "next/navigation";
import { getMessageDragData } from "@/lib/messages/drag-utils";
import { useMailSearch } from "@/components/mail-search/mail-search-context";
import { useConversationView } from "@/components/messages/use-conversation-view";
import { useSelectedMailbox } from "./mailbox-provider";
import { useSidebar } from "./sidebar-state";
import { Edit02 } from "./icons";
import { useCompose } from "./compose/compose-context";
import { Tooltip } from "./ui/tooltip";
import { FULL_ROUTE_PREFETCH } from "@/lib/navigation/prefetch";
import { preloadMailboxPage } from "./components-nav-utils";
import type { NavLink } from "./components-nav-types";

type Props = {
  link: NavLink,
  iconClassName?: string,
  labelClassName?: string,
  wrap?: boolean,
  /** Shows an edit button on hover. */
  onEdit?: () => void,
  editLabel?: string,
  boldActive?: boolean
}
export function NavItem({ link, iconClassName, labelClassName, wrap, onEdit, editLabel, boldActive = true }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const { openComposer } = useCompose();
  const { selectedMailbox } = useSelectedMailbox();
  const { minimal } = useSidebar();
  const { query } = useMailSearch();
  const [conversationView] = useConversationView();
  const [dragOver, setDragOver] = useState(false);
  const prefetchedKey = useRef<string | null>(null);

  if (!link.href) {
    return <span className="flex-1" />;
  }

  const Icon = link.icon;
  if (!Icon) return null;
  const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
  const classes = cn(
    "flex h-9 items-center gap-3 rounded-r-full text-sm text-neutral-700 transition-colors max-md:min-h-11 max-md:text-base",
    minimal && "relative mx-auto w-10 justify-center rounded-full px-0",
    active ? cn("bg-blue-100 text-blue-900", boldActive && "font-semibold") : "hover:bg-neutral-200/60",
    onEdit && "group-hover/nav:bg-neutral-200/60",
    onEdit && active && "group-hover/nav:bg-blue-100",
    dragOver && "bg-blue-50 text-blue-900 ring-1 ring-blue-200",
    link.primary &&
    "mb-3 h-12 w-fit rounded-2xl bg-blue-100 px-5 text-blue-950 shadow-sm hover:bg-blue-200",
    link.count && "font-semibold",
    link.primary && minimal && "h-11 w-11 rounded-2xl px-0",
    wrap && !minimal && "h-auto min-h-9 items-start py-2",
  );
  const dropProps = link.onMessageDrop
    ? {
      onDragOver: (event: DragEvent) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDragOver(true);
      },
      onDragLeave: () => setDragOver(false),
      onDrop: (event: DragEvent) => {
        const payload = getMessageDragData(event.dataTransfer);
        setDragOver(false);
        if (!payload) return;
        event.preventDefault();
        link.onMessageDrop?.(payload.messageIds);
      },
    }
    : {};

  if (link.href === "/compose") {
    const composeButton = (
      <button
        type="button"
        onClick={() => openComposer()}
        className={cn(!minimal && "ml-3", classes)}
        aria-label={minimal ? link.label : undefined}
        {...dropProps}
      >
        <Icon
          size={19}
          style={{ color: link.iconColor }}
          className={iconClassName}
          strokeWidth={2}
        />
        {!minimal && <span className={cn("flex-1", typeof link.count === "number" && link.count > 0 && "font-semibold")}>{link.label}</span>}
        {!minimal && typeof link.count === "number" && link.count > 0 && (
          <span className="ml-auto mr-3 rounded-full px-2 py-0.5 text-sm font-semibold text-neutral-700">
            {link.count > 99 ? "99+" : link.count}
          </span>
        )}
        {minimal && typeof link.count === "number" && link.count > 0 && (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-blue-600 px-1 text-center text-[10px] font-semibold leading-4 text-white">
            {link.count > 99 ? "99+" : link.count}
          </span>
        )}
      </button>
    );
    return minimal && link.label ? <Tooltip label={link.label} placement="right" className="mx-auto">{composeButton}</Tooltip> : composeButton;
  }

  function prefetch() {
    if (!link.preloadMessages || active || !link.href) return;
    const key = [link.href, selectedMailbox?.id ?? "", query, conversationView].join("\u0000");
    if (prefetchedKey.current === key) return;
    prefetchedKey.current = key;
    router.prefetch(link.href, FULL_ROUTE_PREFETCH);
    void preloadMailboxPage(link.href, selectedMailbox?.id, { query, grouped: conversationView })
      .catch(() => { prefetchedKey.current = null; });
  }

  const navLink = (
    <Link
      href={link.href}
      onPointerEnter={prefetch}
      onFocus={prefetch}
      aria-current={active ? "page" : undefined}
      aria-label={minimal ? (typeof link.count === "number" && link.count > 0 ? `${link.label}, ${link.count}` : link.label) : undefined}
      className={cn(!minimal && "pl-6", classes, onEdit && !minimal && !link.count && "[@media(hover:hover)]:pr-11")}
      {...dropProps}
    >
      <Icon
        // className={minimal ? "h-4 w-4" : "h-5 w-5"}
        style={{ color: link.iconColor }}
        size={16}
        strokeWidth={2}
        className={cn("max-md:h-5 max-md:w-5", wrap && !minimal && "mt-0.5 shrink-0", iconClassName)}
      />
      {!minimal && <span className={cn("flex-1", wrap && "min-w-0 break-words leading-5 max-md:leading-6", labelClassName, typeof link.count === "number" && link.count > 0 && "font-semibold")}>{link.label}</span>}
      {!minimal && typeof link.count === "number" && link.count > 0 && (
        <span className={cn("ml-auto mr-3 rounded-full px-2 py-0.5 text-sm font-semibold text-neutral-700", wrap && "shrink-0 py-0 leading-5", onEdit && "[@media(hover:hover)]:group-focus-within/nav:invisible [@media(hover:hover)]:group-hover/nav:invisible")}>
          {link.count > 99 ? "99+" : link.count}
        </span>
      )}
      {minimal && typeof link.count === "number" && link.count > 0 && (
        <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-blue-600 px-1 text-center text-[10px] font-semibold leading-4 text-white">
          {link.count > 99 ? "99+" : link.count}
        </span>
      )}
    </Link>
  );

  if (onEdit && !minimal) {
    // The button sits beside the link, since a link cannot contain a button.
    return (
      <div className="group/nav relative">
        {navLink}
        <button
          type="button"
          onClick={onEdit}
          aria-label={editLabel}
          title={editLabel}
          className="pointer-events-none absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-neutral-600 opacity-0 hover:bg-white hover:text-neutral-900 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/nav:pointer-events-auto group-hover/nav:opacity-100 [@media(hover:none)]:hidden"
        >
          <Edit02 size={14} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <>
      {minimal && link.label ? <Tooltip label={link.label} placement="right" className="mx-auto">{navLink}</Tooltip> : navLink}
    </>
  );
}
