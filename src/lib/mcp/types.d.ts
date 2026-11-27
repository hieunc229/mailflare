import type { SessionUser } from "@/lib/auth/types";

export type McpPrincipal = {
	keyId: string;
	user: SessionUser;
	scopes: string[];
	mailboxIds: string[];
	/** `api_keys.can_approve_own_sends`: may this key release its own send review requests? */
	canApproveOwnSends: boolean;
};
