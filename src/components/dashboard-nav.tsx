"use client";

import type { FormEvent } from "react";
import { useLanguage } from "./language-provider";
import { folderColorKeys } from "@/lib/folders/color-keys";
import type { TranslationKey } from "@/lib/i18n/types";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Archive,
  CalendarClock,
  Clock,
  FileText,
  Folder,
  Inbox,
  MailPlus,
  Plus,
  Send,
  ShieldAlert,
  Star,
  Trash2,
} from "@/components/icons";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { AUTH_SESSION_CHANGED_EVENT, authFetch } from "@/lib/auth/client";
import { getMailboxFolders, invalidateFolderCache } from "@/lib/folders/client";
import {
  DEFAULT_FOLDER_COLOR,
  FOLDER_COLOR_OPTIONS,
} from "@/lib/folders/colors";
import type { FolderColor } from "@/lib/folders/types";
import { cn } from "@/lib/utils";
import { NavItem } from "./components-nav";
import type { NavLink } from "./components-nav-types";
import type { CustomFolder } from "./dashboard-nav-types";
import {
  getFolderNavCount,
  moveMessagesToCustomFolder,
  moveMessagesToSystemFolder,
} from "./dashboard-nav-utils";
import { NavSectionHeader, useSectionOpen } from "./nav-section-header";
import { ReorderableList } from "./reorderable-list";
import { readStorage, writeStorage } from "./reorderable-list-utils";
import { SidebarFooter } from "./sidebar-footer";
import { SidebarHeader } from "./sidebar-header";
import { SidebarScaffold } from "./sidebar-scaffold";
import { useSidebar } from "./sidebar-state";

const links = [
  { href: "/compose", labelKey: "navigation.compose", icon: MailPlus, primary: true },
  { href: "/inbox", labelKey: "navigation.inbox", icon: Inbox, preloadMessages: true },
  { href: "/starred", labelKey: "navigation.starred", icon: Star, preloadMessages: true },
  { href: "/snoozed", labelKey: "navigation.snoozed", icon: Clock, preloadMessages: true },
  { href: "/sent", labelKey: "navigation.sent", icon: Send, preloadMessages: true },
  { href: "/scheduled", labelKey: "navigation.scheduled", icon: CalendarClock, preloadMessages: true },
  { href: "/drafts", labelKey: "navigation.drafts", icon: FileText, preloadMessages: true },
  {
    href: "/archived",
    labelKey: "navigation.archived",
    icon: Archive,
    preloadMessages: true,
  },
  { href: "/spam", labelKey: "navigation.spam", icon: ShieldAlert, preloadMessages: true },
  { href: "/trash", labelKey: "navigation.trash", icon: Trash2, preloadMessages: true },
] satisfies (Omit<NavLink, "label"> & { labelKey: TranslationKey })[];


// Drafts, Archived, Spam and Trash start tucked under "More...".
const MORE_LINK_HREFS = ["/drafts", "/archived", "/spam", "/trash"];
const MAX_VISIBLE_FOLDERS = 3;
const MORE_OPEN_KEY = "mailflare:nav:more-open";
const FOLDERS_OPEN_KEY = "mailflare:nav:folders-open";

function NavToggle({ expanded, onClick, collapsedLabel, expandedLabel }: { expanded: boolean; onClick: () => void; collapsedLabel?: string; expandedLabel?: string }) {
  const { t } = useLanguage();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className="flex h-9 w-full items-center rounded-r-full pl-[52px] text-left text-sm text-neutral-700 transition-colors hover:bg-stone-200/60 max-md:min-h-11 max-md:pl-14 max-md:text-base"
    >
      {expanded ? (expandedLabel ?? t("navigation.less")) : (collapsedLabel ?? t("navigation.more"))}
    </button>
  );
}

export function DashboardNav({ className }: { className?: string }) {
  const { t } = useLanguage();
  const { minimal, mobile } = useSidebar();
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [foldersSectionOpen, toggleFoldersSection] = useSectionOpen("mailflare:nav:folders-section-open");
  const { selectedMailbox, isLoading } = useSelectedMailbox();
  const { counts } = useMessageCounts(selectedMailbox?.id, !isLoading);
  const [folders, setFolders] = useState<CustomFolder[]>([]);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderColor, setNewFolderColor] =
    useState<FolderColor>(DEFAULT_FOLDER_COLOR);
  const [addingFolder, setAddingFolder] = useState(false);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const linksWithCounts: NavLink[] = links.filter((link) => link.href !== "/scheduled" || counts.folders.scheduled.total > 0).map(({ labelKey, ...rest }): NavLink => {
    const link = { ...rest, label: t(labelKey) };
    if (link.href === "/inbox") {
      return { ...link, count: getFolderNavCount("inbox", counts.folders) };
    }
    if (link.href === "/starred") {
      return { ...link, count: getFolderNavCount("starred", counts.folders) };
    }
    if (link.href === "/snoozed") {
      return { ...link, count: getFolderNavCount("snoozed", counts.folders) };
    }
    if (link.href === "/sent") {
      return { ...link, count: getFolderNavCount("sent", counts.folders) };
    }
    if (link.href === "/scheduled") {
      return { ...link, count: counts.folders.scheduled.total };
    }
    if (link.href === "/drafts") {
      return { ...link, count: getFolderNavCount("drafts", counts.folders) };
    }
    if (link.href === "/archived") {
      return {
        ...link,
        count: getFolderNavCount("archived", counts.folders),
        onMessageDrop: (messageIds: string[]) =>
          void moveMessagesToSystemFolder(messageIds, "archive"),
      };
    }
    if (link.href === "/spam") {
      return {
        ...link,
        count: getFolderNavCount("spam", counts.folders),
        onMessageDrop: (messageIds: string[]) =>
          void moveMessagesToSystemFolder(messageIds, "spam"),
      };
    }
    if (link.href === "/trash") {
      return {
        ...link,
        count: getFolderNavCount("trash", counts.folders),
        onMessageDrop: (messageIds: string[]) =>
          void moveMessagesToSystemFolder(messageIds, "trash"),
      };
    }
    return link;
  });

  useEffect(() => {
    setMoreOpen(readStorage(MORE_OPEN_KEY, false));
    setFoldersOpen(readStorage(FOLDERS_OPEN_KEY, false));
  }, []);

  useEffect(() => {
    const reset = () => setFolders([]);
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, reset);
    return () => window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, reset);
  }, []);

  function toggleMore() {
    writeStorage(MORE_OPEN_KEY, !moreOpen);
    setMoreOpen(!moreOpen);
  }

  function toggleFolders() {
    writeStorage(FOLDERS_OPEN_KEY, !foldersOpen);
    setFoldersOpen(!foldersOpen);
  }

  const isActiveHref = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const composeLink = linksWithCounts.find((link) => link.href === "/compose");
  const mainLinks = linksWithCounts.filter((link) => link.href !== "/compose" && !MORE_LINK_HREFS.includes(link.href!));
  const moreLinks = linksWithCounts.filter((link) => MORE_LINK_HREFS.includes(link.href!));
  // The icon rail has no room for text toggles. When collapsed, the page you are on stays listed on its own.
  const showAllMoreLinks = minimal || moreOpen;
  const foldersOverflow = !minimal && folders.length > MAX_VISIBLE_FOLDERS;

  useEffect(() => {
    if (!selectedMailbox?.id) {
      setFolders([]);
      return;
    }

    let cancelled = false;
    getMailboxFolders<{ folders?: CustomFolder[] }>(selectedMailbox.id)
      .then((data) => {
        if (!cancelled) setFolders(data.folders ?? []);
      })
      .catch(() => {
        if (!cancelled) setFolders([]);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedMailbox?.id]);

  async function createFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMailbox?.id || !newFolderName.trim()) return;

    setAddingFolder(true);
    try {
      const response = await authFetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mailboxId: selectedMailbox.id,
          name: newFolderName,
          color: newFolderColor,
        }),
      });
      if (!response.ok) return;
      const folder = (await response.json()) as CustomFolder;
      invalidateFolderCache();
      setFolders((items) =>
        [...items, folder].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setNewFolderName("");
      setNewFolderColor(DEFAULT_FOLDER_COLOR);
      setFolderDialogOpen(false);
    } finally {
      setAddingFolder(false);
    }
  }

  return (
    <SidebarScaffold className={className} header={<SidebarHeader href="/inbox" />} footer={<SidebarFooter />}>
      {composeLink && !mobile && <NavItem labelClassName="font-medium" link={composeLink} />}
      {minimal && <hr className="mx-6 my-2 border-neutral-200/70" />}
      <ReorderableList
        storageKey="mailflare:nav:layout"
        enabled={!minimal}
        lists={[
          { id: "main", items: mainLinks.map((link) => ({ id: link.href!, node: <NavItem link={link} /> })) },
          {
            id: "more",
            before: minimal ? undefined : <NavToggle expanded={moreOpen} onClick={toggleMore} />,
            visibleIds: (ordered) => showAllMoreLinks ? ordered : ordered.filter((id) => isActiveHref(id)),
            items: moreLinks.map((link) => ({ id: link.href!, node: <NavItem link={link} /> })),
          },
        ]}
      />
      {minimal && <hr className="mx-6 my-2 border-neutral-200/70" />}
      {!minimal && (
        <NavSectionHeader label={t("navigation.folders")} open={foldersSectionOpen} onToggle={toggleFoldersSection}>
          {selectedMailbox && (
            <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
              <DialogTrigger asChild>
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 hover:bg-blue-50 hover:text-blue-700"
                  aria-label={t("navigation.createFolder")}
                >
                  <Plus className="h-4 w-4" />
                </button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("navigation.createFolder")}</DialogTitle>
                  <DialogDescription>
                    {t("navigation.folderDescription")}
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={createFolder} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="folderName">{t("navigation.folderName")}</Label>
                    <Input
                      id="folderName"
                      value={newFolderName}
                      onChange={(event) => setNewFolderName(event.target.value)}
                      placeholder={t("navigation.folderExample")}
                      autoFocus
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t("navigation.color")}</Label>
                    <div
                      className="flex flex-wrap gap-2"
                      role="radiogroup"
                      aria-label={t("navigation.folderColor")}
                    >
                      {FOLDER_COLOR_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={newFolderColor === option.value}
                          aria-label={t(folderColorKeys[option.value])}
                          title={t(folderColorKeys[option.value])}
                          onClick={() => setNewFolderColor(option.value)}
                          className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 ${
                            newFolderColor === option.value
                              ? "border-neutral-900 ring-2 ring-neutral-300 ring-offset-2"
                              : "border-transparent"
                          }`}
                          style={{ backgroundColor: option.value }}
                        />
                      ))}
                    </div>
                  </div>
                  <Button
                    type="submit"
                    disabled={addingFolder || !newFolderName.trim()}
                  >
                    {addingFolder ? t("navigation.creating") : t("navigation.createFolder")}
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          )}
        </NavSectionHeader>
      )}
      
      {!minimal && foldersSectionOpen && folders.length === 0 && (
        <div className="px-4 py-1.5 text-xs text-neutral-500">
          {t("navigation.noFolders")}
        </div>
      )}
      {(minimal || foldersSectionOpen) && <ReorderableList
        storageKey="mailflare:nav:layout:folders"
        enabled={!minimal}
        lists={[{
          id: "folders",
          visibleIds: (ordered) => {
            if (!foldersOverflow || foldersOpen) return ordered;
            const first = ordered.slice(0, MAX_VISIBLE_FOLDERS);
            const active = ordered.slice(MAX_VISIBLE_FOLDERS).find((id) => isActiveHref(`/folders/${id}`));
            return active ? [...first, active] : first;
          },
          items: folders.map((folder) => ({
            id: folder.id,
            node: (
              <NavItem
                wrap
                link={{
                  href: `/folders/${folder.id}`,
                  label: folder.name,
                  icon: Folder,
                  preloadMessages: true,
                  iconColor: folder.color,
                  count: counts.customFolders[folder.id]?.unread,
                  onMessageDrop: (messageIds: string[]) =>
                    void moveMessagesToCustomFolder(messageIds, folder.id),
                }}
              />
            ),
          })),
        }]}
      />}
      {foldersSectionOpen && foldersOverflow && <NavToggle expanded={foldersOpen} onClick={toggleFolders} />}
    </SidebarScaffold>
  );
}
