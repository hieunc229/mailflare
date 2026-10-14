"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { fetchCurrentUser } from "@/hooks/use-current-user";
import { readInitialAssistantPanelState, saveAssistantPanelState } from "./dashboard-state-utils";

export function useDashboardState() {
	const [assistantOpen, setAssistantOpen] = useState(false);
	const [assistantFullSize, setAssistantFullSize] = useState(false);
	const [panelRestored, setPanelRestored] = useState(false);
	const [storagePrefix, setStoragePrefix] = useState<string | null>(null);

	useLayoutEffect(() => {
		const saved = readInitialAssistantPanelState();
		setAssistantOpen(saved.open);
		setAssistantFullSize(saved.fullSize);
		setPanelRestored(true);
	}, []);

	useEffect(() => {
		let cancelled = false;
		void fetchCurrentUser().then((user) => {
			if (cancelled || !user?.id) return;
			const prefix = `mailflare-dashboard:${user.id}`;
			try {
				const savedOpen = localStorage.getItem(`${prefix}:assistant-open`);
				const savedFullSize = localStorage.getItem(`${prefix}:assistant-full-size`);
				const initial = readInitialAssistantPanelState();
				setAssistantOpen(savedOpen === null ? initial.open : savedOpen === "true");
				setAssistantFullSize(savedFullSize === null ? initial.fullSize : savedFullSize === "true");
			} catch { /* Storage is optional. */ }
			setStoragePrefix(prefix);
		}).catch(() => undefined);
		return () => { cancelled = true; };
	}, []);

	useEffect(() => {
		if (!panelRestored) return;
		saveAssistantPanelState(assistantOpen, assistantFullSize, storagePrefix);
	}, [panelRestored, storagePrefix, assistantOpen, assistantFullSize]);

	return { assistantOpen, setAssistantOpen, assistantFullSize, setAssistantFullSize };
}
