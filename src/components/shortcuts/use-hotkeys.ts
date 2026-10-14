"use client";

import { useEffect, useRef } from "react";
import type { ShortcutDefinition } from "./types";
import { findSequenceMatch, isModifierKey } from "./use-hotkeys-utils";

interface UseHotkeysOptions {
  enabled?: boolean;
}

export function isTypingInInput(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false;
  return Boolean(target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]'
  ));
}

function matchModifiers(
  e: KeyboardEvent,
  shortcut: ShortcutDefinition
): boolean {
  const requiresCtrl = shortcut.modifiers?.includes("ctrl");
  const requiresMeta = shortcut.modifiers?.includes("meta");
  const requiresAlt = shortcut.modifiers?.includes("alt");
  const requiresShift = shortcut.modifiers?.includes("shift");

  const hasCtrl = e.ctrlKey;
  const hasMeta = e.metaKey;
  const hasAlt = e.altKey;
  const hasShift = e.shiftKey;

  if (requiresCtrl && requiresMeta) {
    if (!hasCtrl && !hasMeta) return false;
  } else if (requiresCtrl && !hasCtrl) {
    return false;
  } else if (requiresMeta && !hasMeta) {
    return false;
  }

  if (requiresAlt && !hasAlt) return false;
  if (requiresShift && !hasShift) return false;
  if (!requiresShift && hasShift && /^[a-z0-9]$/i.test(e.key)) return false;

  if (!requiresCtrl && !requiresMeta && (hasCtrl || hasMeta)) return false;
  if (!requiresAlt && hasAlt) return false;

  return true;
}

export function useHotkeys(
  shortcuts: ShortcutDefinition[],
  options: UseHotkeysOptions = { enabled: true }
) {
  const sequenceBufferRef = useRef<string[]>([]);
  const sequenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shortcutsRef = useRef<ShortcutDefinition[]>(shortcuts);

  useEffect(() => {
    shortcutsRef.current = shortcuts;
  }, [shortcuts]);

  useEffect(() => {
    if (options.enabled === false) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typeof e.key !== "string" || e.isComposing) return;
      const isInput = isTypingInInput(e.target);
      const key = e.key.toLowerCase();
      const resetSequence = () => {
        sequenceBufferRef.current = [];
        if (sequenceTimerRef.current) clearTimeout(sequenceTimerRef.current);
        sequenceTimerRef.current = null;
      };
      const modified = e.metaKey || e.ctrlKey || e.altKey;
      if (modified) resetSequence();

      // Always allow Cmd+K / Ctrl+K
      if ((e.metaKey || e.ctrlKey) && key === "k") {
        const cmdK = shortcutsRef.current.find(
          (s) =>
            s.key.toLowerCase() === "k" &&
            (s.modifiers?.includes("meta") || s.modifiers?.includes("ctrl"))
        );
        if (cmdK && matchModifiers(e, cmdK)) {
          e.preventDefault();
          cmdK.action();
          return;
        }
      }

      if (isInput) {
        resetSequence();
        if (e.key === "Escape") {
          const esc = shortcutsRef.current.find(
            (s) => s.key.toLowerCase() === "escape" || s.key.toLowerCase() === "esc"
          );
          if (esc) esc.action();
        }
        return;
      }

      if (isModifierKey(key)) {
        if (key !== "shift") resetSequence();
        return;
      }

      if (e.target instanceof Element && e.target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;

      if (!modified && key !== "escape" && window.getSelection()?.toString()) {
        resetSequence();
        return;
      }

      // Handle sequence buffer
      if (!modified) sequenceBufferRef.current.push(key);

      if (sequenceTimerRef.current) {
        clearTimeout(sequenceTimerRef.current);
      }

      if (!modified) sequenceTimerRef.current = setTimeout(() => {
        sequenceBufferRef.current = [];
      }, 800);

      const sequenceMatch = modified ? undefined : findSequenceMatch(sequenceBufferRef.current, shortcutsRef.current);

      if (sequenceMatch && matchModifiers(e, sequenceMatch)) {
        e.preventDefault();
        sequenceBufferRef.current = [];
        sequenceMatch.action();
        return;
      }

      const singleMatch = shortcutsRef.current.find((s) => {
        if (s.key.toLowerCase() !== key) return false;
        return matchModifiers(e, s);
      });

      if (singleMatch) {
        e.preventDefault();
        sequenceBufferRef.current = [];
        singleMatch.action();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (sequenceTimerRef.current) {
        clearTimeout(sequenceTimerRef.current);
      }
    };
  }, [options.enabled]);
}
