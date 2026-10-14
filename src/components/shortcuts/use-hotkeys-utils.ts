import type { ShortcutDefinition } from "./types";

const MODIFIER_KEYS = new Set(["shift", "control", "alt", "meta"]);

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

export function findSequenceMatch(
  buffer: string[],
  shortcuts: ShortcutDefinition[],
): ShortcutDefinition | undefined {
  for (let start = 0; start < buffer.length; start++) {
    if (buffer.length > 1 && start === buffer.length - 1) break;
    const sequence = buffer.slice(start).join(" ");
    const match = shortcuts.find((shortcut) => shortcut.key.includes(" ") && shortcut.key.toLowerCase() === sequence);
    if (match) return match;
  }
  return undefined;
}
