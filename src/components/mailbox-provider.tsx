"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import type { ReactNode } from "react";
import {
	fetchMailboxOptions,
	SELECTED_MAILBOX_STORAGE_KEY,
} from "./mailbox-provider-utils";
import {
	AUTH_SESSION_CHANGED_EVENT,
	getClientSessionToken,
} from "@/lib/auth/client";

export type MailboxOption = {
	id: string;
	localPart: string;
	hostname: string;
	displayName: string | null;
	forwardTo?: string | null;
	type?: "personal" | "shared";
	permission?: "read_only" | "send_as" | "send_on_behalf" | "full_access";
	isPrimary?: boolean;
};

type MailboxContextValue = {
	selectedMailbox: MailboxOption | null;
	setSelectedMailbox: (mb: MailboxOption | null) => void;
	mailboxes: MailboxOption[];
	isLoading: boolean;
};

const MailboxContext = createContext<MailboxContextValue | null>(null);

export function useSelectedMailbox() {
	const ctx = useContext(MailboxContext);
	if (!ctx) throw new Error("useSelectedMailbox must be used within MailboxProvider");
	return ctx;
}

export function MailboxProvider({ children }: { children: ReactNode }) {
	const [mailboxes, setMailboxes] = useState<MailboxOption[]>([]);
	const [selectedMailbox, setSelectedMailboxState] = useState<MailboxOption | null>(null);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		const sessionToken = getClientSessionToken();

		fetchMailboxOptions()
			.then((items) => {
				if (cancelled || sessionToken !== getClientSessionToken()) return;
				setMailboxes(items);

				const storedId = localStorage.getItem(SELECTED_MAILBOX_STORAGE_KEY);
				if (storedId) {
					const found = items.find((mb) => mb.id === storedId);
					if (found) {
						setSelectedMailboxState(found);
						return;
					}
				}

				const primary = items.find((mb) => mb.isPrimary) ?? items[0] ?? null;
				if (primary) {
					setSelectedMailboxState(primary);
					localStorage.setItem(SELECTED_MAILBOX_STORAGE_KEY, primary.id);
				}
			})
			.catch(() => {})
			.finally(() => {
				if (!cancelled && sessionToken === getClientSessionToken()) setIsLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		function resetMailboxState() {
			setMailboxes([]);
			setSelectedMailboxState(null);
			setIsLoading(true);
		}

		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, resetMailboxState);
		return () => window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, resetMailboxState);
	}, []);

	const setSelectedMailbox = useCallback((mb: MailboxOption | null) => {
		setSelectedMailboxState((current) => (current?.id === mb?.id ? current : mb));
		if (mb) {
			setMailboxes((items) => items.map((item) => (item.id === mb.id && item !== mb ? mb : item)));
			localStorage.setItem(SELECTED_MAILBOX_STORAGE_KEY, mb.id);
		} else {
			localStorage.removeItem(SELECTED_MAILBOX_STORAGE_KEY);
		}
	}, []);

	return (
		<MailboxContext.Provider value={{ selectedMailbox, setSelectedMailbox, mailboxes, isLoading }}>
			{children}
		</MailboxContext.Provider>
	);
}
