export type ManagedApiKey = {
	id: string;
	name: string;
	prefix: string;
	kind: "legacy" | "mcp";
	scopes: string;
	mailboxIds: string[];
	mailboxScopeEnabled: boolean;
	canApproveOwnSends: boolean;
	createdAt: string;
	lastUsedAt: string | null;
};

export type McpKeyScope = "mcp:read" | "mcp:draft" | "mcp:organize" | "mcp:request-send" | "mcp:calendar-read" | "mcp:calendar-write";
