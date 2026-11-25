/** What the planner needs to know about an item already in a folder. */
export type KnownDriveItem = {
	kind: "file" | "folder";
	size: number;
	/** An unfinished upload. */
	pending: boolean;
	fingerprint: string | null;
	trashed: boolean;
};

export type ImportFileRequest = { name: string; size: number; fingerprint: string };

export type ImportFilePlan =
	| { action: "skip" }
	| { action: "upload"; name: string }
	| { action: "error"; error: string };

export type TakeoutDrivePath = { segments: string[]; directory: boolean } | { error: string };
