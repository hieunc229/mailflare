"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { AUTH_SESSION_CHANGED_EVENT, authFetch } from "@/lib/auth/client";
import { readInitialAssistantAvailability, saveAssistantAvailability } from "@/lib/agent/availability-client";
import type { AssistantAvailabilityResponse } from "./assistant-availability-types";

export function useAssistantAvailability() {
	const [enabled, setEnabled] = useState<boolean | null>(null);
	// eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only; reading it in a lazy initialiser would mismatch the server-rendered markup.
	useLayoutEffect(() => setEnabled(readInitialAssistantAvailability()), []);

	useEffect(() => {
		let active = true;
		const refresh = async () => {
			try {
				const response = await authFetch("/api/agent/availability", { redirectOnUnauthorized: false });
				if (!response.ok) return;
				const data = await response.json() as AssistantAvailabilityResponse;
				if (active) {
					setEnabled(data.enabled);
					saveAssistantAvailability(data.enabled);
				}
			} catch { /* Availability can be refreshed when the window regains focus. */ }
		};
		const onFocus = () => { void refresh(); };
		const onVisibilityChange = () => { if (!document.hidden) void refresh(); };
		void refresh();
		window.addEventListener("focus", onFocus);
		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, onFocus);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			active = false;
			window.removeEventListener("focus", onFocus);
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, onFocus);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, []);

	return enabled;
}
