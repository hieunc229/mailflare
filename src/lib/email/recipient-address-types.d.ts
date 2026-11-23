export type ParsedRecipientAddress = {
	original: string;
	/** The normalized local part with any `+tag` kept. */
	localPart: string;
	/**
	 * The local part without its `+tag`. An empty tag still strips here
	 * (`user+` → `user`) even though `hasSubaddress` is false and `localPart`
	 * stays literal: the base-vs-base comparison sites read this field, so it
	 * describes the base form rather than mirroring `localPart`.
	 */
	baseLocalPart: string;
	/** True when the address carries a non-empty `+tag`. */
	hasSubaddress: boolean;
	domain: string;
	/** `${localPart}@${domain}` — the literal address, tag included. */
	normalizedAddress: string;
	/** `${baseLocalPart}@${domain}` — the subaddress base address; strips an empty tag too. */
	normalizedBaseAddress: string;
};
