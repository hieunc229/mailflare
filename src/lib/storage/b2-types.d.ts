/** Connection to an S3-compatible bucket: Backblaze B2, AWS S3 or any S3-compatible provider. The fields keep their B2 names. */
export type B2Config = {
	keyId: string;
	applicationKey: string;
	bucket: string;
	/** S3-compatible endpoint host without scheme, e.g. s3.us-west-004.backblazeb2.com. */
	endpoint: string;
	/** Signing region, the second label of the endpoint (us-west-004). */
	region: string;
	/** S3_ENDPOINT only: "http" for a local MinIO, otherwise https (the default). */
	protocol?: "https" | "http";
	/** S3_ENDPOINT only: address `endpoint/bucket/key` instead of `bucket.endpoint/key`. */
	pathStyle?: boolean;
	/** Set for S3_ENDPOINT: an admin-chosen host, so signed requests never follow redirects. */
	compatible?: true;
};

export type StorageStatus = {
	provider: "backblaze" | "s3" | "s3-compatible" | "r2" | "files" | "vercel-blob";
	configured: boolean;
	bucket: string | null;
	endpoint: string | null;
	/** s3-compatible only. */
	pathStyle?: boolean;
};

export type B2HttpMetadata = { contentType?: string; contentDisposition?: string; cacheControl?: string };
