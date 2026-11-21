/** D1 rejects a statement with more than 100 bound parameters. */
export const D1_MAX_BOUND_PARAMETERS = 100;

type BatchQuery<Row> = PromiseLike<Row[]> & { toSQL(): { params: unknown[] } };

/**
 * Runs a query that filters on `inArray(column, batch)` once per batch of `ids`, so no statement
 * binds more than D1's limit, and returns every batch's rows together in batch order. The room
 * left for ids is derived from the query itself (its other conditions' parameters), so the caller
 * does not count them. Ids are deduplicated; callers that need a global order must sort the result.
 *
 * Assumes the id list appears once in the query. Mailbox-id lists are part of the fixed parameters
 * and are not batched, so accounts with about 90 or more accessible mailboxes are out of scope.
 */
export async function selectInBatches<Row>(ids: readonly string[], build: (batch: string[]) => BatchQuery<Row>): Promise<Row[]> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return [];
	const fixedParameters = build(unique.slice(0, 1)).toSQL().params.length - 1;
	const size = Math.max(1, D1_MAX_BOUND_PARAMETERS - fixedParameters);
	const rows: Row[] = [];
	for (let index = 0; index < unique.length; index += size) rows.push(...await build(unique.slice(index, index + size)));
	return rows;
}
