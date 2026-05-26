"use client";

import { ComposeForm } from "@/components/compose/compose-form";
import { useCompose } from "@/components/compose/compose-context";

export function FloatingComposer() {
	const { open, draftId, closeComposer } = useCompose();
	if (!open) return null;
	return <ComposeForm key={draftId ?? "new"} mode="popup" draftIdToLoad={draftId} onClose={closeComposer} />;
}
