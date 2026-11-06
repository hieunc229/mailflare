export type PasskeySetupContext = {
	email?: string;
	name?: string;
	kind?: "setup" | "recovery" | "admin";
	expiresAt?: string;
	error?: string;
	code?: string;
};

export type PasskeySetupOptionsResponse = {
	options?: unknown;
	ceremonyToken?: string;
	email?: string;
	error?: string;
	code?: string;
};

export type PasskeySetupResult = {
	ok?: boolean;
	redirect?: string;
	error?: string;
	code?: string;
};
