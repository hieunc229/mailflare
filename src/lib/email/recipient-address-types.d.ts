export type ParsedRecipientAddress = {
	original: string;
	/** The normalized local part with any `+tag` kept. */
	localPart: string;
	/** The local part without its `+tag`; equals `localPart` when there is no tag. */
	baseLocalPart: string;
	/** True when the address carries a non-empty `+tag`. */
	hasSubaddress: boolean;
	domain: string;
	/** `${localPart}@${domain}` — the literal address, tag included. */
	normalizedAddress: string;
	/** `${baseLocalPart}@${domain}` — the subaddress base address. */
	normalizedBaseAddress: string;
};
