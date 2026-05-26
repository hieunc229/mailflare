"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import type { ReactNode } from "react";

export type MailboxOption = {
	id: string;
	localPart: string;
	hostname: string;
	displayName: string | null;
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

const STORAGE_KEY = "selected-mailbox-id";

export function MailboxProvider({ children }: { children: ReactNode }) {
	const [mailboxes, setMailboxes] = useState<MailboxOption[]>([]);
	const [selectedMailbox, setSelectedMailboxState] = useState<MailboxOption | null>(null);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		fetch("/api/mailboxes")
			.then((res) => res.json())
			.then((data) => {
				const items: MailboxOption[] = ((data as { mailboxes: MailboxOption[] }).mailboxes ?? []).map(
					(m: MailboxOption) => ({
						id: m.id,
						localPart: m.localPart,
						hostname: m.hostname,
						displayName: m.displayName,
						isPrimary: m.isPrimary,
					}),
				);
				setMailboxes(items);

				const storedId = localStorage.getItem(STORAGE_KEY);
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
					localStorage.setItem(STORAGE_KEY, primary.id);
				}
			})
			.catch(() => {})
			.finally(() => setIsLoading(false));
	}, []);

	const setSelectedMailbox = useCallback((mb: MailboxOption | null) => {
		setSelectedMailboxState(mb);
		if (mb) {
			localStorage.setItem(STORAGE_KEY, mb.id);
		} else {
			localStorage.removeItem(STORAGE_KEY);
		}
	}, []);

	return (
		<MailboxContext.Provider value={{ selectedMailbox, setSelectedMailbox, mailboxes, isLoading }}>
			{children}
		</MailboxContext.Provider>
	);
}
