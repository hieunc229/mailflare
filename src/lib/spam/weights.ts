export const SPAM_THRESHOLDS = { suspicious: 40, spam: 70 } as const;

export const SPAM_WEIGHTS = {
	authentication: { dmarcFail: 18, dmarcPass: -8, dkimFail: 8, dkimPass: -4, spfFail: 6, spfPass: -2 },
	relationships: { manuallySavedContact: -15, previouslySentTo: -25 },
	reputation: { establishedSpam: 25, establishedHam: -15 },
	content: { maximum: 30 },
	provider: { spamVerdict: 25 },
	blocklists: { ipListed: 30, ipDynamic: 12, domainSpam: 30, domainPhishOrMalware: 45, domainAbusedLegit: 10, urlMalware: 40 },
	domainAge: { underWeek: 25, underMonth: 15, linkUnderWeek: 10 },
	impersonation: { brandDisplayName: 18, addressInDisplayName: 12, lookalikeDomain: 30 },
} as const;

export const MAX_CANDIDATE_TOKENS = 500;
export const MAX_BAYESIAN_TOKENS = 20;
export const TOKENIZER_VERSION = 1;
