export function getRescheduledAt(value: unknown): Date | null {
	if (typeof value !== "string") return null;
	const scheduledAt = new Date(value);
	if (Number.isNaN(scheduledAt.getTime()) || scheduledAt <= new Date()) return null;
	return scheduledAt;
}
