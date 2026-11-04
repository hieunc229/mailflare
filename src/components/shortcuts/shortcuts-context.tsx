"use client";

import React, { createContext, useContext, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Inbox,
  Star,
  Clock,
  Send,
  FileText,
  Archive,
  ShieldAlert,
  Trash2,
  MailPlus,
  Settings,
  HelpCircle,
} from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useCompose } from "@/components/compose/compose-context";
import type { ShortcutDefinition, CommandItem } from "./types";
import { useHotkeys } from "./use-hotkeys";
import { CommandPalette } from "./command-palette";
import { ShortcutsHelpDialog } from "./shortcuts-help-dialog";
import { useShortcutsEnabled } from "./use-shortcuts-enabled";

interface ShortcutsContextValue {
  shortcutsEnabled: boolean;
  shortcutsPreferenceLoading: boolean;
  shortcutsPreferenceError: string | null;
  setShortcutsEnabled: (enabled: boolean) => Promise<void>;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  openHelpModal: () => void;
  closeHelpModal: () => void;
  registerShortcut: (shortcut: ShortcutDefinition) => void;
  registerCommand: (command: CommandItem) => void;
  shortcuts: ShortcutDefinition[];
  commands: CommandItem[];
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

export function useShortcuts() {
  const ctx = useContext(ShortcutsContext);
  if (!ctx) {
    throw new Error("useShortcuts must be used within a ShortcutsProvider");
  }
  return ctx;
}

export function ShortcutsProvider({
  children,
  extraShortcuts = [],
  extraCommands = [],
}: {
  children: React.ReactNode;
  extraShortcuts?: ShortcutDefinition[];
  extraCommands?: CommandItem[];
}) {
  const { t } = useLanguage();
  const router = useRouter();
  const { openComposer } = useCompose();
  const {
    enabled: shortcutsEnabled,
    error: shortcutsPreferenceError,
    isLoading: shortcutsPreferenceLoading,
    setEnabled: setShortcutsEnabled,
  } = useShortcutsEnabled();

  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isHelpModalOpen, setIsHelpModalOpen] = useState(false);
  const [customShortcuts, setCustomShortcuts] = useState<ShortcutDefinition[]>(extraShortcuts);
  const [customCommands, setCustomCommands] = useState<CommandItem[]>(extraCommands);

  const openCommandPalette = () => {
    if (shortcutsEnabled && !shortcutsPreferenceLoading) setIsCommandPaletteOpen(true);
  };
  const closeCommandPalette = () => setIsCommandPaletteOpen(false);
  const openHelpModal = () => {
    if (shortcutsEnabled && !shortcutsPreferenceLoading) setIsHelpModalOpen(true);
  };
  const closeHelpModal = () => setIsHelpModalOpen(false);

  const registerShortcut = (shortcut: ShortcutDefinition) => {
    setCustomShortcuts((prev) => {
      const idx = prev.findIndex((s) => s.key === shortcut.key);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = shortcut;
        return next;
      }
      return [...prev, shortcut];
    });
  };

  const registerCommand = (command: CommandItem) => {
    setCustomCommands((prev) => {
      const idx = prev.findIndex((c) => c.id === command.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = command;
        return next;
      }
      return [...prev, command];
    });
  };

  // Base navigation and global shortcuts
  const baseShortcuts = useMemo<ShortcutDefinition[]>(() => {
    return [
      {
        key: "k",
        modifiers: ["meta", "ctrl"],
        label: t("shortcut.commandPalette"),
        category: "General",
        action: () => setIsCommandPaletteOpen((prev) => !prev),
      },
      {
        key: "?",
        label: t("shortcut.cheatSheet"),
        category: "General",
        action: () => setIsHelpModalOpen((prev) => !prev),
      },
      {
        key: "c",
        label: t("shortcut.compose"),
        category: "Composing",
        action: () => openComposer(),
      },
      {
        key: "/",
        label: t("shortcut.searchMail"),
        category: "Navigation",
        action: () => {
          const searchInput = document.querySelector<HTMLInputElement>(
            'input[data-mail-search-input]'
          );
          if (searchInput) {
            searchInput.focus();
            searchInput.select();
          }
        },
      },
      {
        key: "g i",
        label: t("shortcut.goInbox"),
        category: "Navigation",
        action: () => router.push("/inbox"),
      },
      {
        key: "g s",
        label: t("shortcut.goStarred"),
        category: "Navigation",
        action: () => router.push("/starred"),
      },
      {
        key: "g z",
        label: t("shortcut.goSnoozed"),
        category: "Navigation",
        action: () => router.push("/snoozed"),
      },
      {
        key: "g t",
        label: t("shortcut.goSent"),
        category: "Navigation",
        action: () => router.push("/sent"),
      },
      {
        key: "g d",
        label: t("shortcut.goDrafts"),
        category: "Navigation",
        action: () => router.push("/drafts"),
      },
      {
        key: "g a",
        label: t("shortcut.goArchived"),
        category: "Navigation",
        action: () => router.push("/archived"),
      },
      {
        key: "g !",
        label: t("shortcut.goSpam"),
        category: "Navigation",
        action: () => router.push("/spam"),
      },
      {
        key: "g x",
        label: t("shortcut.goTrash"),
        category: "Navigation",
        action: () => router.push("/trash"),
      },
      {
        key: "escape",
        label: t("shortcut.dismiss"),
        category: "General",
        action: () => {
          setIsCommandPaletteOpen(false);
          setIsHelpModalOpen(false);
        },
      },
      ...customShortcuts,
    ];
  }, [router, openComposer, customShortcuts, t]);

  useHotkeys(baseShortcuts, { enabled: shortcutsEnabled && !shortcutsPreferenceLoading });

  // Base Command Palette actions
  const allCommands = useMemo<CommandItem[]>(() => {
    const builtins: CommandItem[] = [
      {
        id: "compose",
        title: t("palette.composeTitle"),
        subtitle: t("palette.composeSubtitle"),
        category: "Actions",
        icon: MailPlus,
        shortcut: "c",
        perform: () => openComposer(),
      },
      {
        id: "nav-inbox",
        title: t("shortcut.goInbox"),
        category: "Navigation",
        icon: Inbox,
        shortcut: "g i",
        perform: () => router.push("/inbox"),
      },
      {
        id: "nav-starred",
        title: t("shortcut.goStarred"),
        category: "Navigation",
        icon: Star,
        shortcut: "g s",
        perform: () => router.push("/starred"),
      },
      {
        id: "nav-snoozed",
        title: t("shortcut.goSnoozed"),
        category: "Navigation",
        icon: Clock,
        shortcut: "g z",
        perform: () => router.push("/snoozed"),
      },
      {
        id: "nav-sent",
        title: t("shortcut.goSent"),
        category: "Navigation",
        icon: Send,
        shortcut: "g t",
        perform: () => router.push("/sent"),
      },
      {
        id: "nav-drafts",
        title: t("shortcut.goDrafts"),
        category: "Navigation",
        icon: FileText,
        shortcut: "g d",
        perform: () => router.push("/drafts"),
      },
      {
        id: "nav-archived",
        title: t("shortcut.goArchived"),
        category: "Navigation",
        icon: Archive,
        shortcut: "g a",
        perform: () => router.push("/archived"),
      },
      {
        id: "nav-spam",
        title: t("shortcut.goSpam"),
        category: "Navigation",
        icon: ShieldAlert,
        shortcut: "g !",
        perform: () => router.push("/spam"),
      },
      {
        id: "nav-trash",
        title: t("shortcut.goTrash"),
        category: "Navigation",
        icon: Trash2,
        shortcut: "g x",
        perform: () => router.push("/trash"),
      },
      {
        id: "settings-account",
        title: t("palette.accountTitle"),
        subtitle: t("palette.accountSubtitle"),
        category: "Settings",
        icon: Settings,
        perform: () => router.push("/settings/account"),
      },
      {
        id: "show-help",
        title: t("palette.helpTitle"),
        subtitle: t("palette.helpSubtitle"),
        category: "General",
        icon: HelpCircle,
        shortcut: "?",
        perform: () => setIsHelpModalOpen(true),
      },
    ];

    return [...builtins, ...customCommands];
  }, [router, openComposer, customCommands, t]);

  return (
    <ShortcutsContext.Provider
      value={{
        shortcutsEnabled,
        shortcutsPreferenceLoading,
        shortcutsPreferenceError,
        setShortcutsEnabled,
        openCommandPalette,
        closeCommandPalette,
        openHelpModal,
        closeHelpModal,
        registerShortcut,
        registerCommand,
        shortcuts: baseShortcuts,
        commands: allCommands,
      }}
    >
      {children}
      {shortcutsEnabled && !shortcutsPreferenceLoading && (
        <>
          <CommandPalette
            isOpen={isCommandPaletteOpen}
            onClose={closeCommandPalette}
            commands={allCommands}
          />
          <ShortcutsHelpDialog
            isOpen={isHelpModalOpen}
            onClose={closeHelpModal}
            shortcuts={baseShortcuts}
          />
        </>
      )}
    </ShortcutsContext.Provider>
  );
}
