"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Check, LogOut, Mail, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { cn } from "@/lib/utils";

export function MailboxSelector() {
	const { selectedMailbox, setSelectedMailbox, mailboxes, isLoading } =
		useSelectedMailbox();
	const pathname = usePathname();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const { counts } = useMessageCounts();

	useEffect(() => {
		function onPointerDown(event: PointerEvent) {
			if (!ref.current?.contains(event.target as Node)) setOpen(false);
		}

		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, []);

	if (isLoading) return null;

	const selectedName = selectedMailbox?.displayName ?? selectedMailbox?.localPart ?? "All mailboxes";
	const selectedEmail = selectedMailbox
		? `${selectedMailbox.localPart}@${selectedMailbox.hostname}`
		: "All domains";
	const adminActive =
		pathname === "/admin" ||
		pathname.startsWith("/mailboxes") ||
		pathname.startsWith("/domains") ||
		pathname.startsWith("/routing") ||
		pathname.startsWith("/api-keys") ||
		pathname.startsWith("/webhooks") ||
		pathname.startsWith("/settings");

	async function logout() {
		await fetch("/api/auth/logout", { method: "POST" });
		setOpen(false);
		router.push("/login");
	}

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex items-center justify-between gap-3 rounded-full pr-2 pl-4 py-1.5 text-left hover:bg-neutral-200"
			>
				<div className="flex min-w-0 items-center gap-3">
					<div className="min-w-0 text-right flex flex-col justify-center">
						<p className="truncate text-sm font-medium text-neutral-800">{selectedName}</p>
						<p className="truncate text-[11px] text-neutral-500">{selectedEmail}</p>
					</div>
					<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white">
						<Mail className="h-4 w-4" />
					</div>
				</div>
				{/* <ChevronDown className="h-4 w-4 shrink-0 text-neutral-500" /> */}
			</button>
			{open && (
				<div className="absolute right-0 top-12 z-50 w-80 overflow-hidden rounded-2xl border border-neutral-200 bg-white py-2 shadow-xl">
					<div className="px-4 pt-3 pb-2">
						<p className="text-sm font-medium text-neutral-900">Mailboxes</p>
						<p className="text-xs text-neutral-500">Choose the active sending and inbox account.</p>
					</div>
					{mailboxes.map((mb) => {
						const email = `${mb.localPart}@${mb.hostname}`;
						const name = mb.displayName ?? mb.localPart;
						const active = !adminActive && selectedMailbox?.id === mb.id;
						const mailboxCount = counts.mailboxes.find((count) => count.mailboxId === mb.id);
						const unread = mailboxCount?.unread ?? 0;
						const inbox = mailboxCount?.inbox ?? 0;

						return (
							<button
								key={mb.id}
								type="button"
								onClick={() => {
									setSelectedMailbox(mb);
									setOpen(false);
									router.push("/inbox");
								}}
								className={cn(
									"flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[#f2f6fc]",
									active && "bg-blue-50",
								)}
							>
								<div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-100 text-blue-700">
									{name.slice(0, 1).toUpperCase()}
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<p className="truncate text-sm font-medium text-neutral-900">{name}</p>
										{mb.isPrimary && (
											<span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">
												Primary
											</span>
										)}
									</div>
									<p className="truncate text-xs text-neutral-500">
										{email}
										{inbox > 0 && ` · ${inbox} inbox`}
									</p>
								</div>
								{unread > 0 && (
									<span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
										{unread > 99 ? "99+" : unread}
									</span>
								)}
								{active && <Check className="h-4 w-4 text-blue-600" />}
							</button>
						);
					})}
					<div className="mt-2 border-t divide-y divide-neutral-100 border-neutral-100 pt-2">
						<Link
							href="/admin"
							onClick={() => setOpen(false)}
							className={cn(
								"flex items-center gap-3 px-4 py-3 text-sm font-medium text-neutral-700 hover:bg-[#f2f6fc]",
								adminActive && "bg-blue-50",
							)}
						>
							<div className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-100 text-neutral-700">
								<Settings className="h-4 w-4" />
							</div>
							<div>
								<p className="text-sm font-medium text-neutral-900">Admin settings</p>
								<p className="text-xs text-neutral-500">Domains, mailboxes, API keys</p>
							</div>
							{adminActive && <Check className="ml-auto h-4 w-4 text-blue-600" />}
						</Link>
						<button
							type="button"
							onClick={logout}
							className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium text-red-600 hover:bg-red-50"
						>
							<div className="flex h-9 w-9 items-center justify-center rounded-full bg-red-50 text-red-600">
								<LogOut className="h-4 w-4" />
							</div>
							<div>
								<p className="text-sm font-medium">Log out</p>
								<p className="text-xs text-red-500/80">Sign out of this session</p>
							</div>
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
