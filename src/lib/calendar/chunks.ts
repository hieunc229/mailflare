import { chunk } from "../db-params";

/** Splits an id list into D1-safe IN-list chunks. */
export function chunkIds(ids: string[]): string[][] {
	return chunk(ids);
}
