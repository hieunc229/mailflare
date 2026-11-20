import { DRIVE_MAX_DEPTH, DRIVE_MAX_NAME_LENGTH, normalizeDriveName } from "./utils";
import type { ImportFilePlan, ImportFileRequest, KnownDriveItem, TakeoutDrivePath } from "./import-types";

/** C0 and C1 controls, bidirectional embeddings, overrides and isolates, and zero-width characters: invisible, and able to make one name look like another. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u202a-\u202e\u2066-\u2069\ufeff]/g;
const DRIVE_LETTER = /^[a-zA-Z]:/;
/** `name`, then `name (1)` to `name (99)`. */
const COLLISION_CANDIDATES = 100;

/**
 * A name as Drive items of an import are named: invisible characters stripped, NFC, then the usual Drive name rules
 * (which trim and replace slashes). The Drive rules apply last because the upload route applies them to whatever it is given.
 */
export function importName(value: unknown): string | null {
	return typeof value === "string" ? normalizeDriveName(value.replace(INVISIBLE, "").normalize("NFC")) : null;
}

/** What the folders route says about a path that nests too deeply; the import card matches it to show its own translated message. */
export const NESTED_TOO_DEEPLY = "Folders are nested too deeply";

/** Distinct folders one folders request may find or create, every ancestor counted; a 64-deep path fits. Bounds the D1 queries of the request. */
export const MAX_IMPORT_FOLDERS = 64;

/** The distinct folders (every prefix of every path) of `paths`. */
export function folderPrefixes(paths: string[][]): Set<string> {
	const prefixes = new Set<string>();
	for (const path of paths) for (let length = 1; length <= path.length; length += 1) prefixes.add(JSON.stringify(path.slice(0, length)));
	return prefixes;
}

/**
 * The folder and file names of a Takeout zip entry under its Drive folder (`prefix`, e.g. ["Takeout", "Drive"]).
 * Entry names are untrusted: they only ever become Drive item names, never paths, but they are still strict. Both
 * slash styles separate segments; invisible characters (see INVISIBLE) are stripped first, so nothing can hide behind
 * them; `..`, absolute paths, drive letters, names over 255 characters and trees deeper than a Drive allows are
 * rejected, `.` and empty segments dropped, and every segment is named by importName (the server demands the same).
 */
export function takeoutDrivePath(entryName: string, prefix: string[]): TakeoutDrivePath {
	entryName = entryName.replace(INVISIBLE, "").normalize("NFC");
	if (entryName.startsWith("/") || entryName.startsWith("\\") || DRIVE_LETTER.test(entryName)) return { error: "its path is absolute" };
	const parts = entryName.split(/[\\/]/);
	const directory = parts.at(-1) === "";
	const kept = parts.filter((part) => part !== "" && part !== ".");
	if (kept.includes("..")) return { error: "its path goes up a folder" };
	if (prefix.some((part, index) => kept[index] !== part)) return { error: "it is outside the Drive folder" };
	const segments: string[] = [];
	for (const part of kept.slice(prefix.length)) {
		if (part.length > DRIVE_MAX_NAME_LENGTH) return { error: "a name is too long" };
		const name = importName(part);
		if (!name) return { error: "a name is not usable" };
		segments.push(name);
	}
	if ((directory ? segments.length : segments.length - 1) > DRIVE_MAX_DEPTH) return { error: "its folders are nested too deeply" };
	return { segments, directory };
}

const splitName = (name: string) => {
	const dot = name.lastIndexOf(".");
	return { stem: dot > 0 ? name.slice(0, dot) : name, extension: dot > 0 ? name.slice(dot) : "" };
};

/** `a.docx`, `a (1).docx`, ... `a (99).docx`. The last extension stays last, a dotfile has none, and every name fits in 255 characters. */
export function collisionCandidates(name: string): string[] {
	const { stem, extension } = splitName(name);
	const names = [name];
	for (let n = 1; n < COLLISION_CANDIDATES; n += 1) {
		const suffix = ` (${n})${extension}`;
		names.push(`${stem.slice(0, DRIVE_MAX_NAME_LENGTH - suffix.length)}${suffix}`);
	}
	return names;
}

/**
 * A `LIKE ... ESCAPE '!'` pattern that matches every collision candidate after the first (`a (1).docx` to
 * `a (99).docx`), so one query finds them all. It can match other names too; callers compare exact names.
 */
export function collisionPattern(name: string): string {
	const { stem, extension } = splitName(name);
	const escape = (text: string) => text.replace(/[!%_]/g, "!$&");
	const room = DRIVE_MAX_NAME_LENGTH - ` (${COLLISION_CANDIDATES - 1})${extension}`.length;
	// A stem that was cut to fit differs after its first `room` characters, so only that part is known.
	return stem.length <= room ? `${escape(stem)} (%)${escape(extension)}` : `${escape(stem.slice(0, room))}%${escape(extension)}`;
}

/**
 * Decides what to do with one file of a folder, given what is known about the items already there, by exact name
 * (`known` maps a candidate name to the items called that; a missing key means "not looked up yet"). The first
 * candidate name that
 *  1. holds a finished file of the same size: skip, it was imported before;
 *  2. holds an unfinished upload with the same size and fingerprint: upload under that name, which resumes it;
 *  3. holds nothing: upload under that name;
 * otherwise the next one is tried. Trashed items do not hold a name. Returns `unknown` with the name to look up first
 * when the walk reaches a name `known` lacks.
 */
export function planImportFile(known: Map<string, KnownDriveItem[]>, request: ImportFileRequest): ImportFilePlan | { action: "unknown"; name: string } {
	for (const name of collisionCandidates(request.name)) {
		const items = known.get(name);
		if (!items) return { action: "unknown", name };
		const held = items.filter((item) => !item.trashed);
		if (held.some((item) => item.kind === "file" && !item.pending && item.size === request.size)) return { action: "skip" };
		if (held.some((item) => item.kind === "file" && item.pending && item.size === request.size && item.fingerprint === request.fingerprint)) return { action: "upload", name };
		if (held.length === 0) return { action: "upload", name };
	}
	return { action: "error", error: "Too many files with this name" };
}

/** Extension to content type. Anything not listed, HTML, SVG and XML included, is stored as opaque bytes. */
const TYPES: Record<string, string> = {
	pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
	txt: "text/plain", csv: "text/csv", json: "application/json",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet", odp: "application/vnd.oasis.opendocument.presentation",
	zip: "application/zip", mp3: "audio/mpeg", mp4: "video/mp4",
};
const OPAQUE = "application/octet-stream";
const startsWith = (head: Uint8Array, bytes: number[]) => bytes.every((byte, index) => head[index] === byte);
/** First bytes each binary type must start with. Office and OpenDocument files are zips. */
const MAGIC: Record<string, (head: Uint8Array) => boolean> = {
	"application/pdf": (head) => startsWith(head, [0x25, 0x50, 0x44, 0x46]),
	"image/png": (head) => startsWith(head, [0x89, 0x50, 0x4e, 0x47]),
	"image/jpeg": (head) => startsWith(head, [0xff, 0xd8, 0xff]),
	"image/gif": (head) => startsWith(head, [0x47, 0x49, 0x46, 0x38]),
	"image/webp": (head) => startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head.subarray(8), [0x57, 0x45, 0x42, 0x50]),
};
const isZip = (head: Uint8Array) => startsWith(head, [0x50, 0x4b]);

/** Text that opens like markup could be HTML or SVG whatever its extension says. */
function looksLikeMarkup(head: Uint8Array): boolean {
	let index = startsWith(head, [0xef, 0xbb, 0xbf]) ? 3 : 0;
	while (index < head.length && (head[index] === 0x20 || head[index] === 0x09 || head[index] === 0x0a || head[index] === 0x0d)) index += 1;
	return head[index] === 0x3c;
}

/** The content type to store a file with: from its extension, and, when `head` (its first bytes) is given, only if those bytes fit. */
export function contentTypeForName(name: string, head?: Uint8Array): string {
	const dot = name.lastIndexOf(".");
	const type = dot > 0 ? TYPES[name.slice(dot + 1).toLowerCase()] : undefined;
	if (!type) return OPAQUE;
	if (!head) return type;
	if (type.startsWith("text/") || type === "application/json") return looksLikeMarkup(head) || head.includes(0) ? OPAQUE : type;
	const check = MAGIC[type] ?? (/officedocument|opendocument|\/zip$/.test(type) ? isZip : undefined);
	return check && !check(head) ? OPAQUE : type;
}
