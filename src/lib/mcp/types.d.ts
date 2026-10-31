import type { SessionUser } from "@/lib/auth/types";

export type McpPrincipal = {
	keyId: string;
	user: SessionUser;
	scopes: string[];
	mailboxIds: string[];
};

export type McpMailToolName = "list_folders" | "star_email" | "snooze_email" | "move_to_folder" | "search_contacts";
