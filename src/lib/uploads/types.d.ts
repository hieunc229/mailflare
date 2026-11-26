/** Where to PUT a request body, and the name to send the app afterwards. */
export type UploadTicket = { key: string; url: string };

/** What to send instead of a large body: nothing, plus headers naming the stored object. */
export type PreparedUpload<Body> = { body: Body | undefined; headers: Record<string, string> };

export type UploadOptions = {
	onProgress?: (loaded: number, total: number) => void;
	signal?: AbortSignal;
};
