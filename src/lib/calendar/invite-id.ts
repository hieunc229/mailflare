/** One calendar row per (user, invitation UID), so a re-sent or updated invitation edits the same event. */
export async function inviteEventId(userId: string, uid: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${userId}\n${uid}`));
	return `inv_${[...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
