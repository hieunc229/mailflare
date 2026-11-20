import type { DriveUploadSource } from "@/app/(drive)/drive-upload";

export type DriveRunSettings = {
	/** The folder to import into; null is the top of My Drive. Ignored when `newFolderName` is set. */
	parentId: string | null;
	/** Create (or reuse) a folder of this name at the top of My Drive and import into it. */
	newFolderName: string | null;
};

export type DriveRunProgress = {
	/** Files finished, skipped or failed. */
	done: number;
	total: number;
	/** The path of the file being uploaded, or "" between files. */
	current: string;
	/** Of the current file, 0 to 100. */
	percent: number;
};

export type DriveRunSummary = {
	total: number;
	imported: number;
	/** Already in Drive (same name and size). */
	skipped: number;
	/** Of the skipped: files in folders nested deeper than Drive can import into. */
	tooDeep: number;
	failed: number;
	/** Bytes uploaded. */
	bytes: number;
	/** The first few reasons something failed, each starting with the path. */
	errors: string[];
	aborted: boolean;
	/** The per-user Drive storage limit was reached; the run stopped. */
	storageFull: boolean;
	/** Too many uploads failed one after another, so the run stopped instead of trying the rest. */
	stoppedAfterFailures: boolean;
};

/** `retryAfterMs` is the server's Retry-After, when it sent one. */
export type DrivePostResult = { status: number; data: Record<string, unknown>; retryAfterMs?: number };

export type DriveRunDeps = {
	post: (path: "/api/drive/import/folders" | "/api/drive/import/files", body: unknown, signal?: AbortSignal) => Promise<DrivePostResult>;
	upload: (source: DriveUploadSource, parentId: string | null, onProgress: (percent: number, resumed: boolean) => void, signal?: AbortSignal) => Promise<void>;
	signal?: AbortSignal;
	onProgress?: (progress: DriveRunProgress) => void;
	/** Waits before a retry. Tests pass a fake. */
	sleep?: (ms: number) => Promise<void>;
};
