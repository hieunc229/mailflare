/** The Entra app that signs the user in. A null secret means a public client (PKCE). */
export type OutlookApp = {
	clientId: string;
	clientSecret: string | null;
	tenant: string;
};

/** Lives in an HttpOnly cookie for the few minutes between the redirect and the callback. */
export type OutlookPending = OutlookApp & {
	state: string;
	verifier: string;
	userId: string;
};

/**
 * The refresh token that lets an import keep talking to Outlook. It stays in the
 * browser cookie and in queue messages, never on the import job row.
 */
export type OutlookGrant = OutlookApp & {
	refreshToken: string;
	username: string;
	userId: string;
};
