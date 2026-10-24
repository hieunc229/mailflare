import { parseImportDestination } from "@/lib/import/destination";
import type { ImportDestination } from "@/lib/import/destination-types";
import type { ImapImportSpec } from "@/lib/import/jobs-types";
import type { ImapImportRequest } from "./types";

const MAX_IMAP_SOURCES = 200;

export function parseImapImportRequest(input: ImapImportRequest): {
	mailboxId: string;
	password: string;
	spec: ImapImportSpec;
	destinations: ImportDestination[];
} {
	const host = input.host?.trim() ?? "";
	const port = Number(input.port ?? 993);
	const username = input.username?.trim() ?? "";
	const password = input.password ?? "";
	const limit = Math.min(Math.max(Number(input.limit ?? 100), 1), 100);
	const sources = (input.sources ?? []).slice(0, MAX_IMAP_SOURCES).map((source) => ({
		folder: source.folder?.trim() || "INBOX",
		destination: source.destination?.trim() || "system:inbox",
	}));

	if (!input.mailboxId) throw new Error("Mailbox is required");
	if (!host) throw new Error("IMAP host is required");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("IMAP port is invalid");
	if (!username || !password) throw new Error("IMAP username and password are required");
	if (sources.length === 0) throw new Error("Select at least one folder to import");

	// Validates every destination up front; the job parses them again per chunk.
	const destinations = sources.map((source) => parseImportDestination(source.destination));

	return {
		mailboxId: input.mailboxId,
		password,
		destinations,
		spec: { host, port, secure: input.secure ?? port === 993, username, limit, importAll: input.importAll ?? false, sources },
	};
}
