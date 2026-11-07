"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { AUTH_SESSION_CHANGED_EVENT, getClientSessionToken } from "@/lib/auth/client";
import { clearCurrentUserCache, fetchCurrentUser } from "@/hooks/use-current-user";
import type { MailboxSelectorUser } from "@/components/mailbox-selector-types";
import type { HomeAuthProviderProps } from "./types";

const HomeAuthContext = createContext<MailboxSelectorUser | null>(null);

export function HomeAuthProvider({ children, initialUser }: HomeAuthProviderProps) {
	const [user, setUser] = useState<MailboxSelectorUser | null>(initialUser ?? null);

	useEffect(() => {
		// The server already resolved the cookie session. Verify only when it could
		// not answer or the browser holds a bearer token the server cannot see.
		if (initialUser !== undefined && !getClientSessionToken()) return;
		let cancelled = false;
		void fetchCurrentUser().then((next) => {
			if (!cancelled) setUser(next);
		});
		return () => { cancelled = true; };
	}, [initialUser]);

	useEffect(() => {
		function onSessionChanged() {
			clearCurrentUserCache();
			if (!getClientSessionToken()) {
				setUser(null);
				return;
			}
			void fetchCurrentUser().then(setUser);
		}

		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, onSessionChanged);
		return () => window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, onSessionChanged);
	}, []);

	return <HomeAuthContext.Provider value={user}>{children}</HomeAuthContext.Provider>;
}

export function useHomeAuth() {
	return useContext(HomeAuthContext);
}
