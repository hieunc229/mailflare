export type ScheduledJob = {
	/** Shown in the log when the job fails. */
	name: string;
	run: () => Promise<unknown>;
	/** Written for a five-minute cadence; a runtime that ticks more often must space it out. */
	everyFiveMinutes?: boolean;
};
