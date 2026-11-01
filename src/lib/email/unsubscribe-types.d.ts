export type UnsubscribeCandidate = {
	/** The preferred List-Unsubscribe target: an http(s) URL when the sender offers one, else a mailto. */
	url: string;
	/** RFC 8058: the header block carries `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. */
	oneClick: boolean;
};

export type UnsubscribeUrl = UnsubscribeCandidate | null;
