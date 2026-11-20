export const CAPABILITY_CORE = "urn:ietf:params:jmap:core";
export const CAPABILITY_MAIL = "urn:ietf:params:jmap:mail";
export const CAPABILITY_SUBMISSION = "urn:ietf:params:jmap:submission";

export const LIMITS = {
	maxSizeUpload: 10 * 1024 * 1024,
	maxSizeRequest: 10 * 1024 * 1024,
	maxCallsInRequest: 32,
	maxObjectsInGet: 200,
	maxObjectsInSet: 100,
	maxSizeAttachmentsPerEmail: 20 * 1024 * 1024,
	/** Email/query never returns more than this many ids per call. */
	maxQueryLimit: 250,
};

export const KEYWORD_SEEN = "$seen";
export const KEYWORD_FLAGGED = "$flagged";
export const KEYWORD_DRAFT = "$draft";
/** Read-only: set while the message is in Promotions. Clients cannot write it; the Inbox mailbox is unchanged in every mode. */
export const KEYWORD_PROMOTION = "$promotion";
