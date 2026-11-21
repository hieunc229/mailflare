"use client";

import { useEffect, useRef } from "react";
import type { ShortcutDefinition } from "./types";
import { consumeEvent, createSequenceState, matchSequence, recordKey } from "./hotkey-sequence";
import { hasCommandModifier, isModifierKey } from "./use-hotkeys-utils";

interface UseHotkeysOptions {
  enabled?: boolean;
}

export function isTypingInInput(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toUpperCase();
  const isInputOrTextarea =
    tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" ||
    target.closest('[role="combobox"]') !== null;
  const isContentEditable =
    target.isContentEditable ||
    target.getAttribute("contenteditable") === "true";
  return isInputOrTextarea || isContentEditable;
}

const sequenceState = createSequenceState();
let sharedTimer: ReturnType<typeof setTimeout> | null = null;

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

  if (!requiresCtrl && !requiresMeta && (hasCtrl || hasMeta)) return false;
  if (!requiresAlt && hasAlt) return false;

  return true;
}

export function useHotkeys(
  shortcuts: ShortcutDefinition[],
  options: UseHotkeysOptions = { enabled: true }
) {
  const shortcutsRef = useRef<ShortcutDefinition[]>(shortcuts);

  useEffect(() => {
    shortcutsRef.current = shortcuts;
  }, [shortcuts]);

  useEffect(() => {
    if (options.enabled === false) return;

    sequenceState.refs.add(shortcutsRef);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (sequenceState.consumed.has(e)) return;
      const isInput = isTypingInInput(e.target);
      const key = e.key.toLowerCase();

      // Always allow Cmd+K / Ctrl+K
      if ((e.metaKey || e.ctrlKey) && key === "k") {
        const cmdK = shortcutsRef.current.find(
          (s) =>
            s.key.toLowerCase() === "k" &&
            (s.modifiers?.includes("meta") || s.modifiers?.includes("ctrl"))
        );
        if (cmdK) {
          e.preventDefault();
          cmdK.action();
          return;
        }
      }

      if (isInput) {
        if (e.key === "Escape") {
          const esc = shortcutsRef.current.find(
            (s) => s.key.toLowerCase() === "escape" || s.key.toLowerCase() === "esc"
          );
          if (esc) esc.action();
        }
        return;
      }

      if (isModifierKey(key)) return;

      // Cmd/Ctrl/Alt combos belong to the browser and the OS. Sequences and
      // bare-key shortcuts are matched on the bare key, so buffering "c" out of
      // Cmd+C would fire the compose shortcut instead of copying.
      if (hasCommandModifier(e)) return;

      if (e.target instanceof Element && e.target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;

      // Handle sequence buffer (shared; push once per event)
      if (recordKey(sequenceState, e, key)) {
        if (sharedTimer) clearTimeout(sharedTimer);
        sharedTimer = setTimeout(() => {
          sequenceState.buffer = [];
        }, 800);
      }

      const sequenceMatch = matchSequence(sequenceState, shortcutsRef.current);

      if (sequenceMatch) {
        e.preventDefault();
        consumeEvent(sequenceState, e);
        sequenceMatch.action();
        return;
      }

      const singleMatch = shortcutsRef.current.find((s) => {
        if (s.key === "?" && e.key === "?") return true;
        if (s.key === "/" && e.key === "/") return true;
        if (s.key === "#" && e.key === "#") return true;

        if (s.key.toLowerCase() !== key) return false;
        return matchModifiers(e, s);
      });

      if (singleMatch) {
        e.preventDefault();
        consumeEvent(sequenceState, e);
        singleMatch.action();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      sequenceState.refs.delete(shortcutsRef);
    };
  }, [options.enabled]);
}
