"use client";

import React, { useId, useState, useEffect, useRef, useMemo } from "react";
import { Search, CornerDownLeft } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import type { CommandItem } from "./types";
import type { TranslationKey } from "@/lib/i18n/types";
import { filterCommands, groupCommandsByCategory } from "./command-palette-utils";
import { CommandPaletteItem } from "./command-palette-item";
import { useDialogFocus } from "@/components/use-dialog-focus";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: CommandItem[];
}

function CommandPaletteDialog({
  onClose,
  commands,
}: {
  onClose: () => void;
  commands: CommandItem[];
}) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  useDialogFocus(dialogRef, inputRef);

  const filteredCommands = useMemo(
    () => filterCommands(commands, query),
    [commands, query]
  );

  const activeIndex = Math.min(
    selectedIndex,
    Math.max(0, filteredCommands.length - 1)
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % (filteredCommands.length || 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(
        (prev) => (prev - 1 + filteredCommands.length) % (filteredCommands.length || 1)
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredCommands[activeIndex]) {
        filteredCommands[activeIndex].perform();
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const grouped = useMemo(
    () => groupCommandsByCategory(filteredCommands),
    [filteredCommands]
  );

  let flatIndex = 0;
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  useEffect(() => {
    document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listboxId]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 bg-neutral-900/40 backdrop-blur-xs animate-in fade-in duration-100">
      <div className="fixed inset-0" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.placeholder")}
        className="relative w-full max-w-xl bg-white border border-neutral-200 rounded-2xl shadow-2xl overflow-hidden flex flex-col z-10"
        onKeyDown={handleKeyDown}
      >
        {/* Search header */}
        <div className="flex items-center px-4 py-3.5 border-b border-neutral-100 gap-3">
          <Search className="w-5 h-5 text-neutral-400" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder={t("palette.placeholder")}
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={filteredCommands.length ? optionId(activeIndex) : undefined}
            aria-label={t("palette.placeholder")}
            className="w-full bg-transparent text-neutral-900 placeholder-neutral-400 text-[15px] focus:outline-none"
          />
          <kbd className="px-2 py-0.5 text-xs font-semibold text-neutral-500 bg-neutral-100 border border-neutral-200 rounded-md shadow-2xs">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div id={listboxId} role="listbox" aria-label={t("palette.placeholder")} className="max-h-80 overflow-y-auto p-2">
          {filteredCommands.length === 0 ? (
            <div role="status" className="p-8 text-center text-sm text-neutral-500">
              {t("palette.noMatch", { query })}
            </div>
          ) : (
            Object.entries(grouped).map(([category, items]) => (
              <div key={category} role="group" aria-label={t(`shortcut.category.${category}` as TranslationKey)} className="mb-2 last:mb-0">
                <div aria-hidden="true" className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  {t(`shortcut.category.${category}` as TranslationKey)}
                </div>
                {items.map((item) => {
                  const isCurrent = flatIndex === activeIndex;
                  const itemIndex = flatIndex;
                  flatIndex++;

                  return (
                    <CommandPaletteItem
                      key={item.id}
                      id={optionId(itemIndex)}
                      item={item}
                      isActive={isCurrent}
                      onSelect={() => {
                        item.perform();
                        onClose();
                      }}
                      onHover={() => setSelectedIndex(itemIndex)}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 bg-neutral-50 border-t border-neutral-100 flex items-center justify-between text-xs text-neutral-500">
          <div className="flex items-center gap-3">
            <span>
              <kbd className="px-1.5 py-0.5 bg-neutral-200 rounded mr-1 text-[10px]">
                ↑↓
              </kbd>
              {t("palette.navigate")}
            </span>
            <span className="flex items-center">
              <CornerDownLeft className="w-3 h-3 mr-1 inline" />
              {t("palette.select")}
            </span>
          </div>
          <span className="text-[11px]">{t("palette.actions")}</span>
        </div>
      </div>
    </div>
  );
}

export function CommandPalette({
  isOpen,
  onClose,
  commands,
}: CommandPaletteProps) {
  if (!isOpen) return null;
  return <CommandPaletteDialog onClose={onClose} commands={commands} />;
}
