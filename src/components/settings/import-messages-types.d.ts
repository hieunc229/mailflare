import type { ImportJobSummary } from "@/lib/import/jobs-types";

export type ImportMessagesResult = {
	job?: ImportJobSummary;
	error?: string;
};

export type ImportProgressHandler = (percentage: number) => void;

export type ImportMessagesProps = {
	destination: string;
	sourceLabel: string;
};
