// Mailflare: the two types of imapkit's types.d.ts that the ported files use. imapkit is not a dependency.
export type Attribute = any;
export interface Message {
	uid: number;
	flags: string[];
	internaldate: string;
	/** the message source as a binary string (one char per octet) */
	raw: string;
	[key: string]: any;
}
