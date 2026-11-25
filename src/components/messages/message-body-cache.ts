import { AUTH_SESSION_CHANGED_EVENT, authFetch } from "@/lib/auth/client";

export type LoadedMessageBody = { textBody: string | null; htmlBody: string | null };

const MAX_CACHED_BODIES = 30;
const bodies = new Map<string, LoadedMessageBody>();
const requests = new Map<string, Promise<LoadedMessageBody>>();
let generation = 0;

export function getCachedMessageBody(messageId: string): LoadedMessageBody | undefined {
	return bodies.get(messageId);
}

/**
 * One message body from `GET /api/messages/{id}`, which applies the same
 * mailbox access check as the thread. Shared by every card that opens it.
 */
export function fetchMessageBody(messageId: string): Promise<LoadedMessageBody> {
	const cached = bodies.get(messageId);
	if (cached) return Promise.resolve(cached);
	const pending = requests.get(messageId);
	if (pending) return pending;
	const requestGeneration = generation;
	const request = authFetch(`/api/messages/${messageId}`)
		.then(async (response) => {
			if (!response.ok) throw new Error(`Message body request failed (${response.status})`);
			const data = await response.json() as { body?: Partial<LoadedMessageBody> | null };
			const body = { textBody: data.body?.textBody ?? null, htmlBody: data.body?.htmlBody ?? null };
			// A sign-out or account switch mid-flight must not leave this body cached.
			if (requestGeneration === generation) {
				bodies.set(messageId, body);
				if (bodies.size > MAX_CACHED_BODIES) bodies.delete(bodies.keys().next().value as string);
			}
			return body;
		})
		.finally(() => {
			if (requests.get(messageId) === request) requests.delete(messageId);
		});
	requests.set(messageId, request);
	return request;
}

export function clearMessageBodyCache(): void {
	generation += 1;
	bodies.clear();
	requests.clear();
}

if (typeof window !== "undefined") window.addEventListener(AUTH_SESSION_CHANGED_EVENT, clearMessageBodyCache);
