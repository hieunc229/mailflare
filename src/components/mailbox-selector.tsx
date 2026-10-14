"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CalendarDays, Check, HardDrive, ChevronDown, Inbox, LogOut, Settings, ShieldCheck, UserPlus, UserRound, UsersRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useDismissible } from "@/components/use-dismissible";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { ProgressiveAvatarImage } from "@/components/progressive-avatar-image";
import { isIdentityMailbox } from "@/components/mailbox-provider-utils";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { clearCurrentUserCache, fetchCurrentUser } from "@/hooks/use-current-user";
import { getAvatarColorStyle } from "@/lib/avatar-colors";
import { logoutClientSession } from "@/lib/auth/logout";
import { fetchBrowserAccounts, switchBrowserAccount, type BrowserAccount } from "@/lib/auth/accounts-client";
import {
	PROFILE_AVATAR_CHANGED_EVENT,
	getProfileAvatarUrl,
} from "@/lib/profile/avatar-client";
import { PROFILE_NAME_CHANGED_EVENT } from "@/lib/profile/name-client";
import type { ProfileAvatarChangedDetail, ProfileNameChangedDetail } from "@/lib/profile/types";
import { MAILBOX_AVATAR_CHANGED_EVENT } from "@/lib/mailboxes/avatar-client";
import type { MailboxAvatarChangedDetail } from "@/lib/mailboxes/avatar-client-types";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import type {
	AccountAvatarProps,
	MailboxAccountRowProps,
	MailboxSelectorUser,
	MailboxSelectorProps,
} from "./mailbox-selector-types";
import {
	getAccountInitial,
	getMailboxAddress,
	getMailboxName,
	isAdminPath,
} from "./mailbox-selector-utils";

function AccountAvatar({
	name,
	colorSeed = name,
	hasAvatar = false,
	avatarUrl = "/api/profile/avatar",
	size = "small",
	onAvatarError,
}: AccountAvatarProps) {
	const { t } = useLanguage();
	const sizeClass = size === "large" ? "h-16 w-16 text-xl" : "h-10 w-10 text-sm";
	const [imageFailed, setImageFailed] = useState(false);

	useEffect(() => {
		setImageFailed(false);
	}, [avatarUrl, hasAvatar]);

	if (hasAvatar && !imageFailed) {
		return (
			<ProgressiveAvatarImage
				src={avatarUrl}
				alt={t("account.profilePicture", { name })}
				className={`${sizeClass} shrink-0 rounded-full border border-neutral-200 object-cover`}
				onError={() => {
					setImageFailed(true);
					onAvatarError?.();
				}}
			/>
		);
	}

	return (
		<div
			className={`${sizeClass} flex shrink-0 items-center justify-center rounded-full bg-blue-600 font-semibold text-white`}
			style={getAvatarColorStyle(colorSeed)}
			aria-hidden="true"
		>
			{getAccountInitial(name)}
		</div>
	);
}

function MailboxAccountRow({ mailbox, unread, avatarUrl, onSelect }: MailboxAccountRowProps) {
	const { t } = useLanguage();
	const name = getMailboxName(mailbox);

	return (
		<button
			type="button"
			onClick={onSelect}
			className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-white"
		>
			<AccountAvatar
				name={name}
				colorSeed={getMailboxAddress(mailbox)}
				hasAvatar={!!mailbox.hasAvatar || !!avatarUrl}
				avatarUrl={avatarUrl ?? `/api/mailboxes/${mailbox.id}/avatar`}
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<p className="truncate text-sm font-semibold text-neutral-900">{name}</p>
					{mailbox.type === "shared" && (
						<Tooltip label={t("account.sharedInbox")}>
							<span title={t("account.sharedInbox")} aria-label={t("account.sharedInbox")} className="shrink-0 text-blue-600">
								<UsersRound className="h-3.5 w-3.5" />
							</span>
						</Tooltip>
					)}
				</div>
				<p className="truncate text-xs text-neutral-500">{getMailboxAddress(mailbox)}</p>
			</div>
			{unread > 0 && (
				<span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
					{unread > 99 ? "99+" : unread}
				</span>
			)}
		</button>
	);
}

export function MailboxSelector({ initialUser }: MailboxSelectorProps = {}) {
	const { t } = useLanguage();
	const { selectedMailbox, setSelectedMailbox, mailboxes, isLoading } = useSelectedMailbox();
	const pathname = usePathname();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [user, setUser] = useState<MailboxSelectorUser | null>(initialUser ?? null);
	const [hasAvatar, setHasAvatar] = useState(!!initialUser?.hasAvatar);
	const [avatarUrl, setAvatarUrl] = useState("/api/profile/avatar");
	const [mailboxAvatarUrls, setMailboxAvatarUrls] = useState<Record<string, string>>({});
	const [inboxesOpen, setInboxesOpen] = useState(false);
	const [browserAccounts, setBrowserAccounts] = useState<BrowserAccount[]>([]);

	useEffect(() => {
		if (!open) return;
		let active = true;
		void fetchBrowserAccounts().then((accounts) => {
			if (active) setBrowserAccounts(accounts);
		});
		return () => {
			active = false;
		};
	}, [open]);
	const otherAccounts = browserAccounts.filter((account) => !account.active && account.userId !== user?.id);
	const ref = useRef<HTMLDivElement>(null);
	const { counts } = useMessageCounts(null, open);

	useDismissible(open, () => setOpen(false), ref);

	useEffect(() => {
		let active = true;
		void fetchCurrentUser()
			.then((user) => {
				if (!active) return;
				setUser(user);
				setHasAvatar(!!user?.hasAvatar);
			})
			.catch(() => { if (active) setUser(null); });
		return () => { active = false; };
	}, []);

	useEffect(() => {
		function onAvatarChanged(event: Event) {
			clearCurrentUserCache();
			const detail = (event as CustomEvent<ProfileAvatarChangedDetail>).detail;
			setAvatarUrl(detail?.url ?? getProfileAvatarUrl());
			setHasAvatar(true);
			setMailboxAvatarUrls((current) => {
				const next = { ...current };
				const version = Date.now();
				for (const mailbox of mailboxes) {
					if (isIdentityMailbox(mailbox)) {
						next[mailbox.id] = `/api/mailboxes/${mailbox.id}/avatar?v=${version}`;
					}
				}
				return next;
			});
		}

		window.addEventListener(PROFILE_AVATAR_CHANGED_EVENT, onAvatarChanged);
		return () => window.removeEventListener(PROFILE_AVATAR_CHANGED_EVENT, onAvatarChanged);
	}, [mailboxes]);

	useEffect(() => {
		function onNameChanged(event: Event) {
			clearCurrentUserCache();
			const { name } = (event as CustomEvent<ProfileNameChangedDetail>).detail;
			setUser((current) => current ? { ...current, name } : current);
		}

		window.addEventListener(PROFILE_NAME_CHANGED_EVENT, onNameChanged);
		return () => window.removeEventListener(PROFILE_NAME_CHANGED_EVENT, onNameChanged);
	}, []);

	useEffect(() => {
		function onMailboxAvatarChanged(event: Event) {
			const detail = (event as CustomEvent<MailboxAvatarChangedDetail>).detail;
			if (!detail?.mailboxId || !detail.url) return;
			setMailboxAvatarUrls((current) => ({
				...current,
				[detail.mailboxId]: detail.url,
			}));
		}

		window.addEventListener(MAILBOX_AVATAR_CHANGED_EVENT, onMailboxAvatarChanged);
		return () => window.removeEventListener(MAILBOX_AVATAR_CHANGED_EVENT, onMailboxAvatarChanged);
	}, []);

	if (isLoading && !initialUser) {
		return <Skeleton className="h-10 w-10 rounded-full" />;
	}

	const selectedName = selectedMailbox ? getMailboxName(selectedMailbox) : user?.name ?? t("account.fallbackName");
	const selectedEmail = selectedMailbox ? getMailboxAddress(selectedMailbox) : user?.email ?? "";
	const selectedMailboxAvatarUrl = selectedMailbox
		? mailboxAvatarUrls[selectedMailbox.id]
		: undefined;
	const selectedHasAvatar = selectedMailbox
		? !!selectedMailbox.hasAvatar || !!selectedMailboxAvatarUrl
		: hasAvatar;
	const selectedAvatarUrl = selectedMailbox
		? selectedMailboxAvatarUrl ?? `/api/mailboxes/${selectedMailbox.id}/avatar`
		: avatarUrl;
	const otherMailboxes = mailboxes.filter((mailbox) => mailbox.id !== selectedMailbox?.id);
	const adminActive = isAdminPath(pathname);

	async function logout() {
		const switched = await logoutClientSession();
		setOpen(false);
		router.replace(switched ? "/inbox" : "/login");
		router.refresh();
	}

	async function switchAccount(userId: string) {
		const error = await switchBrowserAccount(userId);
		setOpen(false);
		if (error) {
			router.push("/login?add=1");
			return;
		}
		router.replace("/inbox");
		router.refresh();
	}

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="rounded-full p-1 transition-colors hover:bg-neutral-200"
				aria-label={t("account.openMenu")}
				aria-expanded={open}
			>
				<AccountAvatar
					name={selectedName}
					colorSeed={selectedEmail || selectedName}
					hasAvatar={selectedHasAvatar}
					avatarUrl={selectedAvatarUrl}
					onAvatarError={() => {
						if (!selectedMailbox) setHasAvatar(false);
					}}
				/>
			</button>

			{open && (
				<div className="absolute right-0 top-14 w-[360px] overflow-hidden rounded-[28px] border border-neutral-200 bg-[#eef3fb] p-3 shadow-2xl shadow-neutral-900/20 max-h-[82vh] overflow-y-auto z-90">
					<div className="rounded-[22px] bg-white px-5 py-5">
						<div className="flex items-center gap-4">
							<AccountAvatar
								name={selectedName}
								colorSeed={selectedEmail || selectedName}
								hasAvatar={selectedHasAvatar}
								avatarUrl={selectedAvatarUrl}
								size="large"
								onAvatarError={() => {
									if (!selectedMailbox) setHasAvatar(false);
								}}
							/>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<p className="truncate text-lg font-semibold text-neutral-900">{selectedName}</p>
									{selectedMailbox?.type === "shared" && (
										<Tooltip label={t("account.sharedInbox")}>
											<span title={t("account.sharedInbox")} aria-label={t("account.sharedInbox")} className="shrink-0 text-blue-600">
												<UsersRound className="h-4 w-4" />
											</span>
										</Tooltip>
									)}
								</div>
								<p className="truncate text-sm text-neutral-500">
									{selectedEmail}
								</p>
							</div>
							<Check className="h-5 w-5 shrink-0 text-blue-600" />
						</div>
						<Link
							href="/inbox"
							onClick={() => setOpen(false)}
							className="mt-4 flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-[#f2f6fc]"
						>
							<Inbox size={18} className="text-neutral-600" />
							{t("navigation.inbox")}
						</Link>
						<Link
							href="/calendar"
							onClick={() => setOpen(false)}
							className="mt-1 flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-[#f2f6fc]"
						>
							<CalendarDays size={18} className="text-neutral-600" />
							{t("account.calendar")}
						</Link>
						<Link
							href="/drive"
							onClick={() => setOpen(false)}
							className="mt-1 flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-[#f2f6fc]"
						>
							<HardDrive size={18} className="text-neutral-600" />
							{t("account.drive")}
						</Link>
						<Link
							href="/settings/account"
							onClick={() => setOpen(false)}
							className="mt-1 flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-[#f2f6fc]"
						>
							<Settings size={18} className="text-neutral-600" />
							{t("account.settings")}
						</Link>
						{otherMailboxes.length > 0 && (
							<div className="mt-3 border-t border-neutral-100 pt-2">
								<button
									type="button"
									onClick={() => setInboxesOpen((value) => !value)}
									aria-expanded={inboxesOpen}
									className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 hover:bg-[#f2f6fc]"
								>
									{t("account.inboxes", { count: otherMailboxes.length })}
									<ChevronDown size={16} className={`transition-transform ${inboxesOpen ? "rotate-180" : ""}`} />
								</button>
								{inboxesOpen && otherMailboxes.map((mailbox) => {
									const mailboxCount = counts.mailboxes.find((count) => count.mailboxId === mailbox.id);
									return (
										<MailboxAccountRow
											key={mailbox.id}
											mailbox={mailbox}
											unread={mailboxCount?.unread ?? 0}
											avatarUrl={mailboxAvatarUrls[mailbox.id]}
											onSelect={() => {
												setSelectedMailbox(mailbox);
												setOpen(false);
												router.push("/inbox");
											}}
										/>
									);
								})}
							</div>
						)}
					</div>

					{otherAccounts.length > 0 && (
						<div className="mt-2 rounded-[22px] bg-white/55 p-1">
							<p className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
								{t("account.otherAccounts")}
							</p>
							{otherAccounts.map((account) => (
								<button
									key={account.userId}
									type="button"
									onClick={() => void switchAccount(account.userId)}
									className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-white"
								>
									<AccountAvatar
										name={account.name}
										colorSeed={account.email}
										hasAvatar={account.hasAvatar}
										avatarUrl={`/api/auth/accounts/${account.userId}/avatar`}
									/>
									<div className="min-w-0 flex-1">
										<p className="truncate text-sm font-semibold text-neutral-900">{account.name}</p>
										<p className="truncate text-xs text-neutral-500">{account.email}</p>
									</div>
								</button>
							))}
						</div>
					)}

					<div className="mt-2 overflow-hidden rounded-[22px] bg-white">
						{user?.role === "admin" && (
							<Link
								href="/admin"
								onClick={() => setOpen(false)}
								className={`flex items-center gap-3 border-t border-neutral-100 px-5 py-4 text-sm font-medium text-neutral-800 hover:bg-[#f2f6fc] ${adminActive ? "bg-blue-50" : ""}`}
							>
								<ShieldCheck size={18} className="text-neutral-600" />
								{t("account.admin")}
								{adminActive && <Check className="ml-auto h-4 w-4 text-blue-600" />}
							</Link>
						)}
						<Link
							href="/login?add=1"
							onClick={() => setOpen(false)}
							className="flex items-center gap-3 px-5 py-4 text-sm font-medium text-neutral-800 hover:bg-[#f2f6fc]"
						>
							<UserPlus size={18} className="text-neutral-600" />
							{t("account.addAnother")}
						</Link>
						<button
							type="button"
							onClick={logout}
							className="flex w-full items-center gap-3 border-t border-neutral-100 px-5 py-4 text-left text-sm font-medium text-neutral-800 hover:bg-[#f2f6fc]"
						>
							<LogOut size={18} className="text-neutral-600" />
							{t("account.signOut")}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
