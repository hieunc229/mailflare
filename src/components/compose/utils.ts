import type { ComposeDraft, DraftResponse } from "./types";

export async function fetchDraft(draftId: string): Promise<ComposeDraft> {
	const res = await fetch(`/api/drafts/${draftId}`);
	const json = (await res.json()) as DraftResponse;

	if (!res.ok || !json.draft) {
		throw new Error(json.error ?? "Failed to load draft");
	}

	return json.draft;
}
