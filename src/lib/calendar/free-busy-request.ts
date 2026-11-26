import { MAX_FREE_BUSY_DAYS, MAX_FREE_BUSY_IDS } from "./free-busy";

const DAY = 86_400_000;
const MAX_ADDRESS = 254;

export type FreeBusyRequest = { addresses: string[]; resourceIds: string[]; start: Date; end: Date };

const strings = (value: unknown): string[] | null => (value === undefined ? [] : Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null);

/**
 * The body of POST /api/calendar/free-busy: addresses and resource ids (together at most 50, counted before any de-duplication
 * so a request cannot be padded), and a window of at most 62 days. Addresses come back trimmed and lower-cased, once each.
 * Returns the message to answer 400 with when the body is not acceptable.
 */
export function parseFreeBusyRequest(body: Record<string, unknown>): FreeBusyRequest | string {
	const addresses = strings(body.addresses);
	const resourceIds = strings(body.resourceIds);
	if (!addresses || !resourceIds) return "addresses and resourceIds must be lists of text";
	if (addresses.length + resourceIds.length > MAX_FREE_BUSY_IDS) return `Ask about at most ${MAX_FREE_BUSY_IDS} people and rooms at a time`;
	if (typeof body.start !== "string" || typeof body.end !== "string") return "Give a start and an end";
	const start = new Date(body.start);
	const end = new Date(body.end);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return "Give a start before the end";
	if (end.getTime() - start.getTime() > MAX_FREE_BUSY_DAYS * DAY) return `Ask about at most ${MAX_FREE_BUSY_DAYS} days at a time`;
	return { addresses: [...new Set(addresses.map((address) => address.trim().toLowerCase().slice(0, MAX_ADDRESS + 1)))], resourceIds, start, end };
}
