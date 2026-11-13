"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import type { ReactNode } from "react";
import {
	clearMailboxesCache,
	fetchMailboxOptions,
	isIdentityMailbox,
	SELECTED_MAILBOX_STORAGE_KEY,
} from "./mailbox-provider-utils";
import {
	AUTH_SESSION_CHANGED_EVENT,
	getClientSessionToken,
} from "@/lib/auth/client";
import { PROFILE_NAME_CHANGED_EVENT } from "@/lib/profile/name-client";
import { PROFILE_AVATAR_CHANGED_EVENT } from "@/lib/profile/avatar-client";
import type { AuthSessionChangedDetail } from "@/lib/auth/client-types";
import type { ProfileNameChangedDetail } from "@/lib/profile/types";

export type MailboxOption = {
	id: string;
	domainId: string;
	localPart: string;
	hostname: string;
	displayName: string | null;
	signature?: string | null;
	autoReplyEnabled?: boolean;
	autoReplySubject?: string;
	autoReplyBody?: string;
	hasAvatar?: boolean;
	type?: "personal" | "shared";
	permission?: "read_only" | "send_as" | "send_on_behalf" | "full_access";
	isPrimary?: boolean;
	senderAddresses?: string[];
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

	const loadId = useRef(0);

	const loadMailboxes = useCallback(() => {
		const id = ++loadId.current;
		const sessionToken = getClientSessionToken();
		const isCurrent = () => id === loadId.current && sessionToken === getClientSessionToken();

		fetchMailboxOptions()
			.then((items) => {
				if (!isCurrent()) return;
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
				if (isCurrent()) setIsLoading(false);
			});
	}, []);

	useEffect(() => {
		loadMailboxes();
		return () => {
			// Invalidate any request still in flight.
			loadId.current += 1;
		};
	}, [loadMailboxes]);

	useEffect(() => {
		function resetMailboxState(event: Event) {
			setMailboxes([]);
			setSelectedMailboxState(null);
			setIsLoading(true);
			// Signing out has no mailboxes to load.
			if ((event as CustomEvent<AuthSessionChangedDetail>).detail?.authenticated === false) return;
			// The provider outlives an account switch, so load the new account's mailboxes.
			loadMailboxes();
		}

		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, resetMailboxState);
		return () => window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, resetMailboxState);
	}, [loadMailboxes]);

	useEffect(() => {
		function updatePersonalMailboxNames(event: Event) {
			const { name } = (event as CustomEvent<ProfileNameChangedDetail>).detail;
			clearMailboxesCache();
			// Only the primary mailbox follows the profile name; the rest keep their own.
			setMailboxes((items) => items.map((mailbox) => (
				isIdentityMailbox(mailbox) ? { ...mailbox, displayName: name } : mailbox
			)));
			setSelectedMailboxState((mailbox) => (
				mailbox && isIdentityMailbox(mailbox) ? { ...mailbox, displayName: name } : mailbox
			));
		}

		window.addEventListener(PROFILE_NAME_CHANGED_EVENT, updatePersonalMailboxNames);
		return () => window.removeEventListener(PROFILE_NAME_CHANGED_EVENT, updatePersonalMailboxNames);
	}, []);

	useEffect(() => {
		function updatePersonalMailboxAvatars() {
			clearMailboxesCache();
			setMailboxes((items) => items.map((mailbox) => (
				isIdentityMailbox(mailbox) ? { ...mailbox, hasAvatar: true } : mailbox
			)));
			setSelectedMailboxState((mailbox) => (
				mailbox && isIdentityMailbox(mailbox) ? { ...mailbox, hasAvatar: true } : mailbox
			));
		}

		window.addEventListener(PROFILE_AVATAR_CHANGED_EVENT, updatePersonalMailboxAvatars);
		return () => window.removeEventListener(PROFILE_AVATAR_CHANGED_EVENT, updatePersonalMailboxAvatars);
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
