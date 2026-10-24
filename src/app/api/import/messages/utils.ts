import { readFormDataBody } from "@/lib/http/request";
import { DEFAULT_IMPORT_DESTINATION, parseImportDestination } from "@/lib/import/destination";
import type { ImportDestination } from "@/lib/import/destination-types";
import { splitMboxMessages } from "@/lib/import/mbox";
import type { ImportMessageInput } from "@/lib/import/types";

const MAX_IMPORT_REQUEST_SIZE = 25 * 1024 * 1024;
const MAX_IMPORT_MESSAGES = 5000;

function isMboxFile(filename: string, type: string): boolean {
	const name = filename.toLowerCase();
	return name.endsWith(".mbox") || name.endsWith(".mbx") || type === "application/mbox";
}

function isEmlFile(filename: string, type: string): boolean {
	const name = filename.toLowerCase();
	return name.endsWith(".eml") || type === "message/rfc822";
}

function stringToArrayBuffer(value: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(value);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function parseImportForm(request: Request): Promise<{
	mailboxId: string;
	destination: ImportDestination;
	/** The destination as submitted, which the job stores and parses again. */
	destinationValue: string;
	filenames: string[];
	messages: ImportMessageInput[];
}> {
	const form = await readFormDataBody(request, MAX_IMPORT_REQUEST_SIZE);
	const mailboxId = String(form.get("mailboxId") ?? "");
	const destination = parseImportDestination(form.get("destination"));
	const destinationValue = String(form.get("destination") ?? "") || DEFAULT_IMPORT_DESTINATION;
	const files = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
	const messages: ImportMessageInput[] = [];

	for (const file of files) {
		if (isMboxFile(file.name, file.type)) {
			const content = await file.text();
			for (const [index, raw] of splitMboxMessages(content).entries()) {
				messages.push({
					filename: `${file.name}#${index + 1}`,
					raw: stringToArrayBuffer(raw),
				});
			}
			continue;
		}

		if (isEmlFile(file.name, file.type) || file.type === "") {
			messages.push({ filename: file.name, raw: await file.arrayBuffer() });
		}
	}

	return {
		mailboxId,
		destination,
		destinationValue,
		filenames: files.map((file) => file.name),
		messages: messages.slice(0, MAX_IMPORT_MESSAGES),
	};
}
