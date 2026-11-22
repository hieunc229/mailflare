import { parseImportDestination } from "@/lib/import/destination";
import type { ImportDestination } from "@/lib/import/destination-types";
import type { ImapImportSpec } from "@/lib/import/jobs-types";
import { OUTLOOK_IMAP_HOST, OUTLOOK_IMAP_PORT } from "@/lib/import/outlook-utils";

const MAX_SOURCES = 200;

export type OutlookImportBody = {
	mailboxId?: string;
	limit?: number;
	importAll?: boolean;
	sources?: { folder?: string; destination?: string }[];
};

export function parseOutlookImportRequest(input: OutlookImportBody): {
	mailboxId: string;
	spec: ImapImportSpec;
	destinations: ImportDestination[];
} {
	const mailboxId = input.mailboxId?.trim() ?? "";
	const limit = Math.min(Math.max(Number(input.limit ?? 100), 1), 100);
	const sources = (input.sources ?? []).slice(0, MAX_SOURCES).map((source) => ({
		folder: source.folder?.trim() || "INBOX",
		destination: source.destination?.trim() || "system:inbox",
	}));
	if (!mailboxId) throw new Error("Mailbox is required");
	if (sources.length === 0) throw new Error("Select at least one folder to import");
	const destinations = sources.map((source) => parseImportDestination(source.destination));
	return {
		mailboxId,
		destinations,
		spec: {
			host: OUTLOOK_IMAP_HOST,
			port: OUTLOOK_IMAP_PORT,
			secure: true,
			username: "",
			limit,
			importAll: input.importAll ?? false,
			sources,
			auth: "xoauth2",
		},
	};
}
