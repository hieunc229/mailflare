/** A snooze time must name its offset, so a client in another zone cannot snooze to the wrong hour; undefined means rejected. */
export function parseSnoozeUntil(value: string, now = new Date()): Date | undefined {
	if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) return undefined;
	const until = new Date(value);
	if (Number.isNaN(until.getTime()) || until <= now) return undefined;
	return until;
}
