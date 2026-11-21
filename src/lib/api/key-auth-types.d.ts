import type { users } from "@/db/schema";

export type ApiAuthResult = {
	/** The API key that authenticated; mobile push registrations hang off it. */
	keyId: string;
	keyKind: "legacy" | "mcp" | "device" | "app";
	userId: string;
	email: string;
	scopes: string[];
	mailboxIds: string[] | null;
	user: typeof users.$inferSelect;
};
