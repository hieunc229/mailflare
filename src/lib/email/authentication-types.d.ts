export type MessageAuthenticationMethod = {
	/** Provider verdict such as PASS, FAIL or SOFTFAIL. */
	status: string;
	/** Supporting detail from the provider, such as an IP or signing domain. */
	detail: string | null;
};

/**
 * Authentication results the receiving provider recorded. Only the provider
 * headers Mailflare trusts are read, so these values never come from headers
 * the sender wrote.
 */
export type MessageAuthentication = {
	spf: MessageAuthenticationMethod | null;
	dkim: MessageAuthenticationMethod | null;
	dmarc: MessageAuthenticationMethod | null;
	/** Domain that signed the DKIM signature. */
	signedBy: string | null;
	/** Domain the message was mailed from, from SPF. */
	mailedBy: string | null;
	senderIp: string | null;
	/** TLS version used between the sender and the receiving provider. */
	encryption: string | null;
	/** Whether a signing or mailing domain shares the sender's registrable domain. */
	aligned: boolean | null;
};

export type MessageAuthenticationResponse =
	| ({ available: true } & MessageAuthentication)
	| {
			available: false;
			reason: "outbound" | "not-retained" | "unavailable" | "untrusted";
		};
