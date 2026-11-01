export type LoginResult = {
	token?: string;
	redirect?: string;
	error?: string | { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
	/** Password accepted; a code from the authenticator is still needed. */
	mfaRequired?: boolean;
	challengeToken?: string;
};
