import type { ParsedCommand } from "imap-handler";

/** One parsed argument of a command, as imap-handler gives it. */
export type Arg = { type?: string; value?: unknown; section?: Arg[]; partial?: number[] } | Arg[] | null | undefined;

export const args = (command: ParsedCommand): Arg[] => (command.attributes ?? []) as Arg[];

/** The text of an atom, quoted string or literal argument; null for a list, NIL or nothing. */
export function text(arg: Arg): string | null {
	return arg && !Array.isArray(arg) && typeof arg.value === "string" ? arg.value : null;
}

export const isList = (arg: Arg): arg is Arg[] => Array.isArray(arg);
