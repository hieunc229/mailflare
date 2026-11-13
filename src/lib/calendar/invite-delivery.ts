/** Sends one message per attendee and returns the addresses that failed, so a saved event is never reported as a failed request. */
export async function sendToAttendees(attendees: string[], send: (to: string) => Promise<unknown>): Promise<string[]> {
	const results = await Promise.allSettled(attendees.map((to) => send(to)));
	const failed: string[] = [];
	results.forEach((result, index) => {
		if (result.status !== "rejected") return;
		failed.push(attendees[index]);
		console.warn(`Calendar invitation to ${attendees[index]} failed:`, result.reason instanceof Error ? result.reason.message : result.reason);
	});
	return failed;
}
