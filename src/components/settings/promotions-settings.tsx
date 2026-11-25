"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import type { MailboxOption } from "@/components/mailbox-provider";
import { getMailboxAddress } from "@/components/messages/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { authFetch } from "@/lib/auth/client";
import { dispatchMessagesChanged } from "@/lib/messages/change-events";
import {
	canManagePromotions,
	getBackfillNotice,
	getModeErrorKey,
	PROMOTION_MODE_OPTIONS,
	type BackfillState,
	type PromotionModeValue,
} from "@/lib/promotions/ui-utils";

type MailboxState = {
	status: "loading" | "ready" | "error";
	mode: PromotionModeValue;
	backfill: BackfillState | null;
	saving: boolean;
	error: string | null;
};

type PromotionsResponse = { mode?: PromotionModeValue; backfill?: BackfillState; error?: string; code?: string };

const POLL_MS = 5000;
const INITIAL_STATE: MailboxState = { status: "loading", mode: "off", backfill: null, saving: false, error: null };
const MODE_HELP = {
	off: "settings.promotions.helpOff",
	show: "settings.promotions.helpShow",
	separate: "settings.promotions.helpSeparate",
} as const;

export function PromotionsSettings() {
	const { t } = useLanguage();
	const { mailboxes, isLoading } = useSelectedMailbox();
	const [states, setStates] = useState<Record<string, MailboxState>>({});
	const mailboxIds = mailboxes.map((mailbox) => mailbox.id).join(",");
	const statesRef = useRef(states);
	useEffect(() => {
		statesRef.current = states;
	}, [states]);

	const patch = useCallback((id: string, next: Partial<MailboxState>) => {
		setStates((current) => ({
			...current,
			[id]: { ...INITIAL_STATE, ...current[id], ...next },
		}));
	}, []);

	const load = useCallback(async (id: string, quiet = false) => {
		try {
			const response = await authFetch(`/api/mailboxes/${id}/promotions`);
			const data = (await response.json().catch(() => ({}))) as PromotionsResponse;
			if (!response.ok || !data.mode) throw new Error(data.error ?? "load failed");
			patch(id, { status: "ready", mode: data.mode, backfill: data.backfill ?? null, ...(quiet ? {} : { error: null }) });
		} catch {
			if (!quiet) patch(id, { status: "error" });
		}
	}, [patch]);

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect -- loads each mailbox's setting from the server; setState runs after the request resolves.
		for (const id of mailboxIds ? mailboxIds.split(",") : []) void load(id);
	}, [mailboxIds, load]);

	// Progress text follows the background sort while the page is open; nothing runs once every job is idle, done or failed.
	const working = Object.values(states).some((state) => state.backfill?.status === "pending" || state.backfill?.status === "running");
	useEffect(() => {
		if (!working) return;
		const timer = window.setInterval(() => {
			if (document.visibilityState !== "visible") return;
			for (const [id, state] of Object.entries(statesRef.current)) {
				if (state.backfill?.status === "pending" || state.backfill?.status === "running") void load(id, true);
			}
		}, POLL_MS);
		return () => window.clearInterval(timer);
	}, [working, load]);

	async function save(id: string, mode: PromotionModeValue) {
		patch(id, { saving: true, error: null });
		try {
			const response = await authFetch(`/api/mailboxes/${id}/promotions`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode }),
			});
			const data = (await response.json().catch(() => ({}))) as PromotionsResponse;
			if (!response.ok || !data.mode) {
				patch(id, { saving: false, error: t(getModeErrorKey(response.status, data.code)) });
				return;
			}
			patch(id, { saving: false, mode: data.mode, backfill: data.backfill ?? null });
			// The nav entry, counts and Inbox contents all depend on the mode.
			dispatchMessagesChanged();
		} catch {
			patch(id, { saving: false, error: t("settings.promotions.saveFailed") });
		}
	}

	if (isLoading) return <Skeleton className="h-20 rounded-xl" />;
	if (mailboxes.length === 0) return <p className="text-sm text-neutral-500">{t("settings.promotions.noMailboxes")}</p>;

	return (
		<div className="space-y-3">
			{mailboxes.map((mailbox) => (
				<MailboxRow
					key={mailbox.id}
					mailbox={mailbox}
					state={states[mailbox.id]}
					onChange={(mode) => void save(mailbox.id, mode)}
					onRetry={(mode) => void save(mailbox.id, mode)}
					onReload={() => void load(mailbox.id)}
				/>
			))}
			<p className="px-1 text-sm text-neutral-500">
				<Link href="/subscriptions" className="font-medium text-blue-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
					{t("settings.promotions.manageSubscriptions")}
				</Link>
			</p>
		</div>
	);
}

type MailboxRowProps = {
	mailbox: MailboxOption;
	state: MailboxState | undefined;
	onChange: (mode: PromotionModeValue) => void;
	onRetry: (mode: PromotionModeValue) => void;
	onReload: () => void;
};

function MailboxRow({ mailbox, state, onChange, onRetry, onReload }: MailboxRowProps) {
	const { t } = useLanguage();
	const address = getMailboxAddress(mailbox) ?? mailbox.id;
	const labelId = `promotions-${mailbox.id}-label`;
	const helpId = `promotions-${mailbox.id}-help`;
	const noteId = `promotions-${mailbox.id}-note`;
	const canManage = canManagePromotions(mailbox.permission);
	const ready = state?.status === "ready";
	// An off mailbox has nothing to report, even when an earlier sort failed.
	const notice = ready && state.mode !== "off" ? getBackfillNotice(state.backfill) : { kind: "none" as const };

	return (
		<div className="rounded-xl bg-neutral-50 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<span id={labelId} className="min-w-0 truncate text-sm font-medium text-neutral-900">{address}</span>
				{!state || state.status === "loading" ? (
					<Skeleton className="h-9 w-56" />
				) : state.status === "error" ? (
					<span className="flex items-center gap-3 text-sm text-red-600">
						<span role="alert">{t("settings.promotions.loadFailed")}</span>
						<Button type="button" variant="outline" size="sm" onClick={onReload}>{t("settings.promotions.reload")}</Button>
					</span>
				) : (
					<Select
						value={state.mode}
						disabled={!canManage || state.saving}
						onChange={(event) => onChange(event.target.value as PromotionModeValue)}
						className="py-1.5 text-sm text-neutral-800"
						containerClassName="w-full sm:w-64"
						aria-labelledby={labelId}
						aria-describedby={canManage ? helpId : `${helpId} ${noteId}`}
					>
						{PROMOTION_MODE_OPTIONS.map((option) => (
							<option key={option.value} value={option.value}>{t(option.labelKey)}</option>
						))}
					</Select>
				)}
			</div>
			{ready && (
				<p id={helpId} className="mt-2 text-sm text-neutral-500">{t(MODE_HELP[state.mode])}</p>
			)}
			{ready && !canManage && (
				<p id={noteId} className="mt-1 text-sm text-neutral-500">{t("settings.promotions.readOnlyNote")}</p>
			)}
			{state?.saving && <p role="status" className="mt-2 text-sm text-neutral-500">{t("settings.promotions.saving")}</p>}
			{state?.error && <p role="alert" className="mt-2 text-sm text-red-600">{state.error}</p>}
			<div aria-live="polite">
				{(notice.kind === "pending" || notice.kind === "running" || notice.kind === "done") && (
					<p className="mt-2 text-sm text-neutral-600">{t(notice.key, "vars" in notice ? notice.vars : undefined)}</p>
				)}
			</div>
			{notice.kind === "failed" && (
				<div role="alert" className="mt-2 flex flex-wrap items-center gap-3 text-sm text-red-600">
					<span>
						{t(notice.key)}
						{notice.error ? ` ${notice.error}` : ""}
					</span>
					{canManage && (
						<Button type="button" variant="outline" size="sm" disabled={state?.saving} onClick={() => onRetry(state!.mode)}>
							{t("settings.promotions.tryAgain")}
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
