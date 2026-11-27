/** Where to PUT a request body, any headers to send with it, and the name to send the app afterwards. */
export type UploadTicket = { key: string; url: string; headers?: Record<string, string> };

/** A storage backend that signs its own upload URLs (Vercel Blob), as the env's `UPLOAD_PRESIGNER`. */
export type UploadPresigner = (key: string, size: number, expiresSeconds: number) => Promise<{ url: string; headers?: Record<string, string> }>;

/** What to send instead of a large body: nothing, plus headers naming the stored object. */
export type PreparedUpload<Body> = { body: Body | undefined; headers: Record<string, string> };

export type UploadOptions = {
	onProgress?: (loaded: number, total: number) => void;
	signal?: AbortSignal;
};
