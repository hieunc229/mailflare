import { readFormDataBody } from "@/lib/http/request";
import { DEFAULT_IMPORT_DESTINATION, parseImportDestination } from "@/lib/import/destination";
import type { ImportDestination } from "@/lib/import/destination-types";
import { splitMboxBytes } from "@/lib/import/mbox";
import type { ImportMessageInput } from "@/lib/import/types";

const MAX_IMPORT_REQUEST_SIZE = 25 * 1024 * 1024;
/** Without `background`, the request imports inline (the Takeout uploader), so it stays small. */
const MAX_INLINE_IMPORT_MESSAGES = 100;
const MAX_BACKGROUND_IMPORT_MESSAGES = 5000;

function isMboxFile(filename: string, type: string): boolean {
	const name = filename.toLowerCase();
	return name.endsWith(".mbox") || name.endsWith(".mbx") || type === "application/mbox";
}

function isEmlFile(filename: string, type: string): boolean {
	const name = filename.toLowerCase();
	return name.endsWith(".eml") || type === "message/rfc822";
}

type ImportFileFlags = Record<string, { read?: unknown; starred?: unknown }>;

/** Optional `flags` field: JSON mapping an uploaded file name to its source read/starred state. */
function parseImportFlags(value: FormDataEntryValue | null): ImportFileFlags {
	if (typeof value !== "string" || !value) return {};
	const parsed: unknown = JSON.parse(value);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Import flags are invalid");
	return parsed as ImportFileFlags;
}

function getMessageFlags(flags: ImportFileFlags, filename: string): Pick<ImportMessageInput, "read" | "starred"> {
	const entry = flags[filename];
	if (!entry) return {};
	return {
		...(typeof entry.read === "boolean" ? { read: entry.read } : {}),
		...(typeof entry.starred === "boolean" ? { starred: entry.starred } : {}),
	};
}

export async function parseImportForm(request: Request): Promise<{
	mailboxId: string;
	destination: ImportDestination;
	/** The destination as submitted, which the job stores and parses again. */
	destinationValue: string;
	filenames: string[];
	/** Queue the import as a job instead of importing before responding. */
	background: boolean;
	messages: ImportMessageInput[];
	/** How many messages beyond the per-request limit were left out. */
	truncated: number;
}> {
	const form = await readFormDataBody(request, MAX_IMPORT_REQUEST_SIZE);
	const mailboxId = String(form.get("mailboxId") ?? "");
	const destination = parseImportDestination(form.get("destination"));
	const flags = parseImportFlags(form.get("flags"));
	const destinationValue = String(form.get("destination") ?? "") || DEFAULT_IMPORT_DESTINATION;
	const background = form.get("background") === "1";
	const files = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
	const messages: ImportMessageInput[] = [];

	for (const file of files) {
		if (isMboxFile(file.name, file.type)) {
			// Split the bytes, not decoded text, so 8-bit bodies reach the parser as they were written.
			for (const [index, raw] of splitMboxBytes(await file.arrayBuffer()).entries()) {
				const filename = `${file.name}#${index + 1}`;
				messages.push({ filename, raw, ...getMessageFlags(flags, filename) });
			}
			continue;
		}

		if (isEmlFile(file.name, file.type) || file.type === "") {
			messages.push({ filename: file.name, raw: await file.arrayBuffer(), ...getMessageFlags(flags, file.name) });
		}
	}

	const limit = background ? MAX_BACKGROUND_IMPORT_MESSAGES : MAX_INLINE_IMPORT_MESSAGES;
	return {
		mailboxId,
		destination,
		destinationValue,
		filenames: files.map((file) => file.name),
		background,
		messages: messages.slice(0, limit),
		truncated: Math.max(0, messages.length - limit),
	};
}
