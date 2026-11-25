import { CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION, LIMITS } from "./constants";
import type { JmapContext } from "./types";

/** Origin clients should use for JMAP: the configured APP_URL, else the origin the request arrived on. */
export function jmapOrigin(env: Pick<CloudflareEnv, "APP_URL">, request: Request): string {
	return env.APP_URL?.trim() || new URL(request.url).origin;
}

/** The full session URL a client without /.well-known discovery needs. */
export function jmapSessionUrl(env: Pick<CloudflareEnv, "APP_URL">, request: Request): string {
	return `${jmapOrigin(env, request)}/jmap/session`;
}

/** The Session object (RFC 8620 §2). One account per API key: the key's user. */
export function buildSession(ctx: JmapContext, sessionState: string) {
	const base = `${ctx.origin}/jmap`;
	return {
		capabilities: {
			[CAPABILITY_CORE]: {
				maxSizeUpload: LIMITS.maxSizeUpload,
				maxConcurrentUpload: 4,
				maxSizeRequest: LIMITS.maxSizeRequest,
				maxConcurrentRequests: 4,
				maxCallsInRequest: LIMITS.maxCallsInRequest,
				maxObjectsInGet: LIMITS.maxObjectsInGet,
				maxObjectsInSet: LIMITS.maxObjectsInSet,
				collationAlgorithms: ["i;ascii-casemap", "i;unicode-casemap"],
			},
			[CAPABILITY_MAIL]: {},
			[CAPABILITY_SUBMISSION]: {},
		},
		accounts: {
			[ctx.accountId]: {
				name: ctx.auth.email,
				isPersonal: true,
				isReadOnly: false,
				accountCapabilities: {
					[CAPABILITY_MAIL]: {
						maxMailboxesPerEmail: 1,
						maxMailboxDepth: 2,
						maxSizeMailboxName: 80,
						maxSizeAttachmentsPerEmail: LIMITS.maxSizeAttachmentsPerEmail,
						emailQuerySortOptions: ["receivedAt", "sentAt", "subject", "from", "size", "hasKeyword"],
						mayCreateTopLevelMailbox: false,
					},
					[CAPABILITY_SUBMISSION]: {
						maxDelayedSend: 0,
						submissionExtensions: {},
					},
				},
			},
		},
		primaryAccounts: {
			[CAPABILITY_MAIL]: ctx.accountId,
			[CAPABILITY_SUBMISSION]: ctx.accountId,
		},
		username: ctx.auth.email,
		apiUrl: `${base}/api`,
		downloadUrl: `${base}/download/{accountId}/{blobId}/{name}?type={type}`,
		uploadUrl: `${base}/upload/{accountId}`,
		eventSourceUrl: `${base}/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
		state: sessionState,
	};
}
