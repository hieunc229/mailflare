/** D1 allows at most 100 bound parameters per statement; id-IN lists stay at 90 like messages. */
export const D1_IN_CHUNK = 90;

/** Splits an id list into D1-safe IN-list chunks. */
export function chunkIds(ids: string[]): string[][] {
	const chunks: string[][] = [];
	for (let index = 0; index < ids.length; index += D1_IN_CHUNK) chunks.push(ids.slice(index, index + D1_IN_CHUNK));
	return chunks;
}
