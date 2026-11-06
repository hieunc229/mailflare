export type UnsubscribeCandidate = {
	/** The preferred List-Unsubscribe target: an http(s) URL when the sender offers one, else a mailto. */
	url: string;
	/** RFC 8058: the header block carries `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. */
	oneClick: boolean;
	/** The `mailto:` target when the header also lists one, so a failed or unsupported one-click can fall back to email. */
	mailto: string | null;
	/** Some DKIM signature's h= list covers List-Unsubscribe, so the header is less likely relay-injected. */
	dkimCoversUnsubscribe: boolean;
};

export type UnsubscribeUrl = UnsubscribeCandidate | null;
export type UnsubscribeMethod = "one-click" | "mailto" | "link";

export type MailtoUnsubscribeTarget = {
	to: string;
	subject: string;
	text: string;
};
