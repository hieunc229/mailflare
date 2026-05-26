"use client";

import { ComposeForm } from "@/components/compose/compose-form";
import { useCompose } from "@/components/compose/compose-context";

export function FloatingComposer() {
	const { open, closeComposer } = useCompose();
	if (!open) return null;
	return <ComposeForm mode="popup" onClose={closeComposer} />;
}
