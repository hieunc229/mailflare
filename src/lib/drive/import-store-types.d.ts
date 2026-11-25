import type { ImportFilePlan } from "./import-types";

export type ImportFolderResult = {
	/** `path.join("/")` to the folder's id. */
	folders: Record<string, string>;
	/** `path.join("/")` to the reason that path was refused. */
	errors: Record<string, string>;
};

/** One file to plan: the folder it goes into (null for the root of `ownerId`'s Drive), who owns that folder, and its identity. */
export type ImportFileInput = { ownerId: string; folderId: string | null; name: string; size: number; fingerprint: string };

export type ImportFileOutcome = ImportFilePlan;
