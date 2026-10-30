export type PasskeyLoginOptions = {
	options?: unknown;
	ceremonyToken?: string;
	error?: string;
	code?: string;
};

export type LoginResult = {
	token?: string;
	redirect?: string;
	error?: string;
	code?: string;
	/** Password accepted; a second factor is still needed. */
	mfaRequired?: boolean;
	challengeToken?: string;
	/** Factors this account can finish the challenge with. */
	methods?: string[];
	method?: string;
};
