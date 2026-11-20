import type { CalendarSource } from "@/lib/import/takeout-data-types";
import type { CalendarRunSummary } from "@/lib/import/takeout-calendar-types";

export type CalendarRowState = {
	included: boolean;
	color: string;
	googleAddress: string;
};

export type CalendarRunProgress = {
	mode: "import" | "preview";
	label: string;
	index: number;
	count: number;
	done: number;
	total: number;
};

export type CalendarRunResult = {
	id: string;
	label: string;
	mode: "import" | "preview";
	summary: CalendarRunSummary;
};

export type TakeoutCalendarCardProps = {
	sources: CalendarSource[];
};
