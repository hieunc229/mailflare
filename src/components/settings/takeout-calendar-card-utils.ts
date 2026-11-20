import type { CalendarRunResult } from "./takeout-calendar-card-types";

/** The radio to select for an arrow, Home or End key, wrapping at both ends; null for any other key. */
export function radioTarget(key: string, index: number, count: number): number | null {
	if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
	if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	return null;
}

/** "failed" when nothing worked, "partial" when something failed or the run was stopped or limited, else "success". */
export function resultTone(results: CalendarRunResult[]): "success" | "partial" | "failed" {
	let worked = 0;
	let problem = false;
	for (const { mode, summary } of results) {
		// An import fills `events` with the whole file, whatever happened to it.
		worked += mode === "import" ? summary.imported + summary.skipped : summary.events;
		problem ||= summary.failed > 0 || summary.aborted || summary.rateLimited;
	}
	if (!problem) return "success";
	return worked === 0 ? "failed" : "partial";
}
