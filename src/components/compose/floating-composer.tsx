"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MailPlus } from "@/components/icons";
import { usePathname, useRouter } from "next/navigation";
import { ComposeForm } from "@/components/compose/compose-form";
import { useCompose } from "@/components/compose/compose-context";
import type { ComposeNotice, ComposeNoticeAction } from "@/components/compose/compose-context";
import { useSidebar } from "@/components/sidebar-state";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import { cn } from "@/lib/utils";

const STATUS_POLL_MS = 1000;

function ComposeNoticeToast({ notice }: { notice: ComposeNotice }) {
	const [now, setNow] = useState(() => Date.now());
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	const countdownEnded = useRef(false);
	const countdown = notice.countdown;
	const parts = notice.parts;
	useEffect(() => {
		if (!countdown) return;
		const timer = window.setInterval(() => setNow(Date.now()), 250);
		return () => window.clearInterval(timer);
	}, [countdown]);
	useEffect(() => {
		if (!countdown || !notice.onCountdownEnd || countdownEnded.current) return;
		if (now < countdown.endAt) return;
		countdownEnded.current = true;
		notice.onCountdownEnd();
	}, [countdown, notice, now]);

	// Delivery is asynchronous after the countdown; watch the persisted status instead of guessing.
	useEffect(() => {
		const poll = notice.poll;
		if (!poll) return;
		let cancelled = false;
		let timer: number | undefined;
		const check = async () => {
			if (cancelled) return;
			try {
				const response = await authFetch(`/api/messages/${poll.messageId}/send-status`);
				if (cancelled) return;
				if (response.ok) {
					const data = await response.json() as { status?: string };
					if (data.status === "sent") { poll.onStatus("sent"); return; }
					if (data.status === "failed") { poll.onStatus("failed"); return; }
					if (data.status === "draft") { poll.onStatus("cancelled"); return; }
				}
			} catch {
				// A transient poll failure keeps the toast waiting until the next attempt.
			}
			if (!cancelled) timer = window.setTimeout(() => void check(), STATUS_POLL_MS);
		};
		void check();
		return () => {
			cancelled = true;
			if (timer) window.clearTimeout(timer);
		};
	}, [notice.poll]);

	const secondsLeft = countdown ? Math.max(0, Math.ceil((countdown.endAt - now) / 1000)) : null;
	const ticker = parts?.ticker && secondsLeft !== null ? parts.ticker(secondsLeft) : null;

	async function runAction(action: ComposeNoticeAction) {
		if (pendingAction) return;
		const result = action.onClick();
		if (!(result instanceof Promise)) return;
		setPendingAction(action.label);
		try {
			await result;
		} finally {
			setPendingAction(null);
		}
	}

	return (
		<div
			role="status"
			aria-atomic="false"
			className={cn(
				"fixed right-6 top-6 z-[60] flex max-w-[calc(100vw-3rem)] items-center gap-4 rounded-lg px-4 py-3 text-sm font-medium text-white shadow-lg",
				notice.tone === "error" ? "bg-red-600" : "bg-green-600",
			)}
		>
			<span className="min-w-0 break-words">
				{parts ? (
					<>
						{parts.before}
						{parts.link && (
							// The underline follows the text colour so it stays legible on
							// both the success and the error toast, hover included.
							<Link href={parts.link.href} className="underline decoration-current underline-offset-2 hover:decoration-current">
								{parts.link.label}
							</Link>
						)}
						{parts.after}
						{/* The countdown changes every second; keep it out of the live region. */}
						{ticker !== null && <span aria-live="off">{ticker}</span>}
					</>
				) : notice.message}
			</span>
			{notice.actions.map((action) => (
				<button
					key={action.label}
					type="button"
					onClick={() => void runAction(action)}
					disabled={pendingAction !== null}
					className="shrink-0 rounded-md bg-white/20 px-2.5 py-1 font-semibold hover:bg-white/30 disabled:cursor-wait disabled:opacity-60"
				>
					{action.label}
				</button>
			))}
		</div>
	);
}

/** `showButton` adds the phone Compose button; only the dashboard pages (mail) pass it. */
export function FloatingComposer({ showButton = false }: { showButton?: boolean }) {
	const { open, draftId, openComposer, closeComposer, notice } = useCompose();
	const pathname = usePathname();
	const router = useRouter();
	const { t } = useLanguage();
	const { mobileOpen } = useSidebar();
	return (
		<>
			{showButton && !open && !mobileOpen && (
				<button
					type="button"
					onClick={openComposer}
					aria-label={t("navigation.compose")}
					className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 flex h-12 items-center gap-3 rounded-2xl bg-blue-100 px-5 text-base font-medium text-blue-950 shadow-sm transition-colors hover:bg-blue-200 active:bg-blue-200 md:hidden"
				>
					<MailPlus size={19} />
					{t("navigation.compose")}
				</button>
			)}
			{notice && <ComposeNoticeToast key={notice.id} notice={notice} />}
			{open && <ComposeForm key={draftId ?? "new"} mode="popup" draftIdToLoad={draftId} onClose={() => {
				closeComposer();
				if (/^\/drafts\/[^/]+\/?$/.test(pathname)) router.replace("/drafts");
			}} />}
		</>
	);
}
