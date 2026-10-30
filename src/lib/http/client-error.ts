/** An API failure that keeps its stable code for translation at the call site. */
export class ClientRequestError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "ClientRequestError";
	}
}

export function requestError(data: { error?: unknown; code?: unknown }, fallback: string): ClientRequestError {
	return new ClientRequestError(typeof data.error === "string" ? data.error : fallback, typeof data.code === "string" ? data.code : undefined);
}
