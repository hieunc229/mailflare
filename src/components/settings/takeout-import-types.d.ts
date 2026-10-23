import type { TakeoutImportSummary } from "@/lib/import/gmail-takeout-types";

/** One .mbox to import: a picked .mbox file, or an .mbox entry inside a picked Takeout zip. */
export interface TakeoutSource {
	/** Stable across page loads, used to continue an interrupted import. */
	key: string;
	label: string;
	/** Uncompressed size in bytes. */
	size: number;
	open: () => Promise<ReadableStream<Uint8Array>>;
}

export interface TakeoutSourceList {
	sources: TakeoutSource[];
	/** Picked zip files that contain no .mbox. */
	withoutMbox: string[];
}

export interface TakeoutRunState {
	mode: "preview" | "import";
	sourceIndex: number;
	sourceCount: number;
	sourceLabel: string;
	bytesRead: number;
	bytesTotal: number;
	resumedAt: number;
	summary: TakeoutImportSummary;
}
