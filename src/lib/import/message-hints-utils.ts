// The explicit extension lets the node:test suite load this file directly.
// @ts-expect-error TS5097: allowImportingTsExtensions is off
import { mapGmailLabels, parseGmailLabels } from "./gmail-takeout-utils.ts";
import type { ImportDestination } from "./destination-types";

export type ImportMessageHints = {
	read?: boolean;
	starred?: boolean;
	/** Set only when the message itself says it belongs in spam or trash. */
	section?: "spam" | "trash";
};

function readHeaders(raw: ArrayBuffer): string {
	const bytes = new Uint8Array(raw);
	let end = Math.min(bytes.length, 64 * 1024);
	for (let index = 0; index < end - 1; index += 1) {
		if (bytes[index] === 10 && (bytes[index + 1] === 10 || (bytes[index + 1] === 13 && bytes[index + 2] === 10))) {
			end = index;
			break;
		}
	}
	return new TextDecoder().decode(bytes.subarray(0, end)).replace(/\r?\n[ \t]+/g, " ");
}

/**
 * Exports carry their own state: mbox `Status`, Gmail labels, spam-filter verdicts.
 * Used where the upload gave no per-message flags.
 */
export function getImportMessageHints(raw: ArrayBuffer): ImportMessageHints {
	const hints: ImportMessageHints = {};
	const headers = readHeaders(raw);

	const status = headers.match(/^Status:[ \t]*(.*)$/im);
	if (status) hints.read = status[1].toUpperCase().includes("R");

	const labels = parseGmailLabels(new Uint8Array(raw));
	if (labels.length) {
		const placement = mapGmailLabels(labels, { folders: false });
		hints.read = placement.read;
		hints.starred = placement.starred;
		const destination = placement.destination;
		if (destination.type === "system" && (destination.section === "spam" || destination.section === "trash")) {
			hints.section = destination.section;
		}
	}

	if (!hints.section && /^X-Spam-Flag:[ \t]*yes\b/im.test(headers)) hints.section = "spam";
	return hints;
}

/** A hint only refines the default destination; a section or folder the user picked is kept. */
export function applyImportHints(destination: ImportDestination, hints: ImportMessageHints): ImportDestination {
	if (hints.section && destination.type === "system" && destination.section === "inbox") {
		return { type: "system", section: hints.section };
	}
	return destination;
}
