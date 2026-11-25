import type { ContactSource } from "@/lib/import/takeout-data-types";
import type { ContactRunSummary } from "@/lib/import/takeout-contacts-types";

export type ContactRunProgress = {
	mode: "import" | "preview";
	label: string;
	index: number;
	count: number;
	done: number;
	total: number;
};

export type ContactRunResult = {
	id: string;
	label: string;
	mode: "import" | "preview";
	/** Photos are only imported from vCard files, and only when asked for. */
	photos: boolean;
	summary: ContactRunSummary;
};

export type TakeoutContactsCardProps = {
	sources: ContactSource[];
};
