"use client";

import React, { useId, useRef } from "react";
import { X, Keyboard } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import type { TranslationKey } from "@/lib/i18n/types";
import type { ShortcutDefinition } from "./types";
import { useDialogFocus } from "@/components/use-dialog-focus";

interface ShortcutsHelpDialogProps {
  isOpen: boolean;
  onClose: () => void;
  shortcuts: ShortcutDefinition[];
}

// Puts a styled key badge where the translation has its {key} placeholder.
function withKey(text: string, key: string) {
  const [before, after = ""] = text.split("{key}");
  return (
    <>
      {before}
      <kbd className="px-1.5 py-0.5 bg-neutral-200 text-neutral-700 rounded font-mono">{key}</kbd>
      {after}
    </>
  );
}

export function ShortcutsHelpDialog({ isOpen, onClose, shortcuts }: ShortcutsHelpDialogProps) {
  if (!isOpen) return null;
  return <ShortcutsHelpDialogContent onClose={onClose} shortcuts={shortcuts} />;
}

function ShortcutsHelpDialogContent({
  onClose,
  shortcuts,
}: Omit<ShortcutsHelpDialogProps, "isOpen">) {
  const { t } = useLanguage();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useDialogFocus(dialogRef, closeRef);

  const grouped = shortcuts.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {} as Record<string, ShortcutDefinition[]>);

  const formatKey = (shortcut: ShortcutDefinition) => {
    const parts: string[] = [];
    if (shortcut.modifiers) {
      shortcut.modifiers.forEach((m) => {
        if (m === "ctrl") parts.push(t("shortcutsHelp.ctrl"));
        if (m === "meta") parts.push("⌘");
        if (m === "alt") parts.push("Alt");
        if (m === "shift") parts.push("Shift");
      });
    }
    parts.push(shortcut.key.toUpperCase());
    return parts.join(" + ");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-900/40 backdrop-blur-xs animate-in fade-in duration-100">
      <div
        className="fixed inset-0"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key !== "Escape" && event.key !== "?") return;
          event.stopPropagation();
          onClose();
        }}
        className="relative w-full max-w-2xl bg-white border border-neutral-200 rounded-2xl shadow-2xl overflow-hidden flex flex-col z-10 max-h-[85vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-blue-50 text-blue-600 rounded-lg">
              <Keyboard className="w-5 h-5" />
            </div>
            <div>
              <h2 id={titleId} className="text-base font-semibold text-neutral-900">
                {t("shortcutsHelp.title")}
              </h2>
              <p className="text-xs text-neutral-500">
                {t("shortcutsHelp.subtitle")}
              </p>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t("shortcutsHelp.close")}
            className="text-neutral-400 hover:text-neutral-700 p-1.5 rounded-lg hover:bg-neutral-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Categories */}
        <div className="overflow-y-auto p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          {Object.entries(grouped).map(([category, items]) => (
            <div key={category} className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 border-b border-neutral-100 pb-1.5">
                {t(`shortcut.category.${category}` as TranslationKey)}
              </h3>
              <div className="space-y-2">
                {items.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-neutral-700">
                      {item.label}
                    </span>
                    <kbd className="px-2 py-0.5 text-xs font-mono font-medium text-neutral-600 bg-neutral-100 border border-neutral-200 rounded-md shadow-2xs">
                      {formatKey(item)}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-neutral-50 border-t border-neutral-100 flex items-center justify-between text-xs text-neutral-500">
          <span>{withKey(t("shortcutsHelp.pressToToggle", { key: "{key}" }), "?")}</span>
          <span>{withKey(t("shortcutsHelp.pressToClose", { key: "{key}" }), "ESC")}</span>
        </div>
      </div>
    </div>
  );
}
