export const SPAM_THRESHOLDS = { suspicious: 40, spam: 70 } as const;

/** Per-user strictness: the score at which a message moves to Spam. "normal" equals SPAM_THRESHOLDS.spam; the database default is "strict". */
export const SPAM_STRICTNESS_THRESHOLDS = { relaxed: 85, normal: SPAM_THRESHOLDS.spam, strict: 55 } as const;
export const SPAM_STRICTNESS_LEVELS = ["relaxed", "normal", "strict"] as const;

export const SPAM_WEIGHTS = {
	authentication: { dmarcFail: 18, dmarcPass: -8, dkimFail: 8, dkimPass: -4, spfFail: 6, spfPass: -2,
		/** Passes count this fraction for a first contact; saved or written-to contacts, good reputation and recurring senders get all of it. */
		unknownSenderPassScale: 0.5 },
	relationships: { manuallySavedContact: -15, previouslySentTo: -25 },
	reputation: { establishedSpam: 25, establishedHam: -15 },
	content: { maximum: 30, coldSolicitation: 45 },
	provider: { spamVerdict: 25 },
	blocklists: { ipListed: 30, ipDynamic: 12, domainSpam: 30, domainPhishOrMalware: 45, domainAbusedLegit: 10, urlMalware: 40 },
	domainAge: { underWeek: 25, underMonth: 15, linkUnderWeek: 10 },
	impersonation: { brandDisplayName: 18, addressInDisplayName: 12, lookalikeDomain: 30 },
} as const;

export const MAX_CANDIDATE_TOKENS = 500;
export const MAX_BAYESIAN_TOKENS = 20;
export const TOKENIZER_VERSION = 1;
