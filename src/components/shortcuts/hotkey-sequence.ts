import type { ShortcutDefinition } from "./types";
import { findSequenceMatch } from "./use-hotkeys-utils";

export type ShortcutRef = { current: ShortcutDefinition[] };

/**
 * Key buffer shared by every mounted useHotkeys, so a multi-key sequence such
 * as "g !" is matched against all registered shortcuts by whichever listener
 * sees the key first, and the other listeners skip that event.
 */
export interface SequenceState {
  buffer: string[];
  refs: Set<ShortcutRef>;
  lastEvent: object | null;
  consumed: WeakSet<object>;
}

export function createSequenceState(): SequenceState {
  return { buffer: [], refs: new Set(), lastEvent: null, consumed: new WeakSet() };
}

/** Pushes the key once per event. Returns true when the key was newly buffered. */
export function recordKey(state: SequenceState, event: object, key: string): boolean {
  if (state.lastEvent === event) return false;
  state.lastEvent = event;
  state.buffer.push(key);
  return true;
}

/** Sequences are matched across all registered shortcuts; a single key only against the caller's own. */
export function matchSequence(state: SequenceState, own: ShortcutDefinition[]): ShortcutDefinition | undefined {
  const candidates = state.buffer.length > 1 ? [...state.refs].flatMap((ref) => ref.current) : own;
  return findSequenceMatch(state.buffer, candidates);
}

export function consumeEvent(state: SequenceState, event: object): void {
  state.consumed.add(event);
  state.buffer = [];
}
