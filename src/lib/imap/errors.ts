/** A command that ends with NO or BAD: the text is for the client and never echoes what the client sent. */
export class ImapError extends Error {
	constructor(readonly status: "NO" | "BAD", message: string, readonly code?: string) {
		super(message);
	}
}
export const bad = (message: string) => new ImapError("BAD", message);
export const no = (message: string, code?: string) => new ImapError("NO", message, code);
