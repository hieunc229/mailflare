/**
 * The latest read/star values this tab has seen for message ids. Action
 * responses, list/thread/detail fetches and cache patches all feed it, so an
 * undo can snapshot what was on screen before its optimistic patch instead of
 * assuming an older action's historical "applied" state is still current.
 */
export type KnownMessageFields = {
	read?: boolean;
	starred?: boolean;
};

const knownFields = new Map<string, KnownMessageFields>();

export function rememberMessageFields(messageIds: string[], patch: KnownMessageFields): void {
	if (patch.read === undefined && patch.starred === undefined) return;
	for (const id of messageIds) {
		const current = knownFields.get(id) ?? {};
		knownFields.set(id, {
			...current,
			...(patch.read !== undefined ? { read: patch.read } : {}),
			...(patch.starred !== undefined ? { starred: patch.starred } : {}),
		});
	}
}

export function rememberMessageRows(rows: Array<{ id: string; read?: boolean; starred?: boolean }>): void {
	for (const row of rows) {
		if (row.read === undefined && row.starred === undefined) continue;
		rememberMessageFields([row.id], {
			...(row.read !== undefined ? { read: row.read } : {}),
			...(row.starred !== undefined ? { starred: row.starred } : {}),
		});
	}
}

/** Copies only fields this tab has actually observed; unknown ids stay unknown. */
export function captureMessageFields(ids: string[]): Map<string, KnownMessageFields> {
	const captured = new Map<string, KnownMessageFields>();
	for (const id of new Set(ids)) {
		const fields = knownFields.get(id);
		if (fields) captured.set(id, { ...fields });
	}
	return captured;
}

/** Test-only reset. */
export function clearKnownMessageFieldsForTests(): void {
	knownFields.clear();
}
