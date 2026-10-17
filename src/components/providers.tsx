"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { clearMailboxClientState } from "@/components/mailbox-provider-utils";
import { BrandingProvider } from "@/components/branding-provider";
import type { Branding } from "@/lib/branding/types";
import { NewMessagePopup } from "@/components/new-message-popup";
import { PwaServiceWorker } from "@/components/pwa-service-worker";
import { ThemeSync } from "@/components/theme-sync";
import { useMessagePolling } from "@/hooks/use-message-polling";
import { clearMessageClientState } from "@/hooks/utils";
import { clearMessageDetailCache } from "@/lib/messages/detail-cache";
import { clearCurrentUserCache } from "@/hooks/use-current-user";
import { AUTH_SESSION_CHANGED_EVENT } from "@/lib/auth/client";
import type { AuthSessionChangedDetail } from "@/lib/auth/client-types";

export function Providers({ children, initialBranding }: { children: React.ReactNode; initialBranding?: Branding }) {
	const realtime = useMessagePolling();

	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						refetchOnMount: false,
						refetchOnReconnect: false,
						refetchOnWindowFocus: false,
						staleTime: 60_000,
					},
				},
			}),
	);

	useEffect(() => {
		function resetUserScopedState(event: Event) {
			client.clear();
			clearMailboxClientState();
			clearMessageClientState();
			clearMessageDetailCache();
			clearCurrentUserCache();
			// The dashboard layout outlives an account switch, so its all-mailbox counts (the app badge) would keep the old account's number.
			if ((event as CustomEvent<AuthSessionChangedDetail>).detail?.authenticated) {
				window.dispatchEvent(new Event("mailflare:message-counts-changed"));
			}
		}

		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, resetUserScopedState);
		return () => window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, resetUserScopedState);
	}, [client]);

	return (
		<QueryClientProvider client={client}>
			<BrandingProvider initialBranding={initialBranding}>
				<PwaServiceWorker />
				{children}
				<ThemeSync />
				<div role="status" aria-live="polite">
					{realtime.notification && (
						<NewMessagePopup
							notification={realtime.notification}
							onDismiss={realtime.dismissNotification}
						/>
					)}
				</div>
			</BrandingProvider>
		</QueryClientProvider>
	);
}
