"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { getMailboxAddress } from "@/components/messages/utils";
import { blockMessageContact, openUnsubscribeUrl } from "@/components/message-actions/utils";
import { requestUnsubscribe } from "@/components/messages/unsubscribe-button-utils";
import { Button } from "@/components/ui/button";
import { confirmDestructive, confirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { dispatchMessagesChanged } from "@/lib/messages/change-events";
import type { CopyDescriptor } from "@/lib/promotions/move-utils";
import { fetchSubscriptions, previewSenderTrash, saveSenderCategory, trashSender } from "@/lib/promotions/subscriptions-client";
import {
	categoryResultCopy,
	categoryToApi,
	getPager,
	getRowView,
	mailboxesWithPromotions,
	pageBackOffset,
	pickMailboxId,
	SUBSCRIPTIONS_PAGE_SIZE,
	trashConfirmCopy,
	trashResultCopy,
} from "@/lib/promotions/subscriptions-ui-utils";
import type { SubscriptionCategory, SubscriptionRowAction, SubscriptionRowData } from "@/lib/promotions/subscriptions-ui-types";
import { CategoryControl, LastReceived, MessageCount, RowActions, SenderCell, ReadRate } from "./subscription-parts";

type Notice = { tone: "ok" | "error"; items: CopyDescriptor[] };
type ListState = { status: "loading" | "ready" | "error"; senders: SubscriptionRowData[]; total: number };

const LOADING: ListState = { status: "loading", senders: [], total: 0 };

export function SubscriptionsPage() {
	const { t } = useLanguage();
	const { mailboxes, selectedMailbox, isLoading: mailboxesLoading } = useSelectedMailbox();
	// A refetch after an action flips isLoading again; the list stays up, only the first load shows a skeleton.
	// No mailbox id asks for every mailbox the user can read, which is what the picker needs.
	const { counts, isLoading: countsLoading } = useMessageCounts(null);
	const [countsSeen, setCountsSeen] = useState(false);
	if (!countsLoading && !countsSeen) setCountsSeen(true);
	const choices = useMemo(() => mailboxesWithPromotions(mailboxes, counts.promotionModes), [mailboxes, counts.promotionModes]);
	const choiceIds = choices.map((mailbox) => mailbox.id).join(",");

	const [chosen, setChosen] = useState<string | null>(null);
	const mailboxId = pickMailboxId(choiceIds ? choiceIds.split(",") : [], chosen, selectedMailbox?.id);
	const mailbox = choices.find((item) => item.id === mailboxId);
	const permission = mailbox?.permission;

	const [offset, setOffset] = useState(0);
	const [list, setList] = useState<ListState>(LOADING);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const requestRef = useRef(0);

	const load = useCallback(async (id: string, at: number, quiet = false) => {
		const request = ++requestRef.current;
		if (!quiet) setList(LOADING);
		try {
			const page = await fetchSubscriptions({ mailboxId: id, offset: at, limit: SUBSCRIPTIONS_PAGE_SIZE });
			if (request !== requestRef.current) return;
			// The last sender of a page was trashed or moved: show the page before it.
			const back = pageBackOffset({ offset: at, pageSize: SUBSCRIPTIONS_PAGE_SIZE, returned: page.senders.length, total: page.total });
			if (back !== at) {
				setOffset(back);
				return;
			}
			setList({ status: "ready", senders: page.senders, total: page.total });
		} catch {
			if (request === requestRef.current) setList({ ...LOADING, status: "error" });
		}
	}, []);

	useEffect(() => {
		if (!mailboxId) return;
		// eslint-disable-next-line react-hooks/set-state-in-effect -- loads the page from the server; setState runs after the request resolves.
		void load(mailboxId, offset);
	}, [mailboxId, offset, load]);

	function chooseMailbox(id: string) {
		setChosen(id);
		setOffset(0);
		setNotice(null);
	}

	const say = (tone: Notice["tone"], ...items: CopyDescriptor[]) => setNotice({ tone, items });
	const refresh = () => {
		dispatchMessagesChanged();
		return mailboxId ? load(mailboxId, offset, true) : undefined;
	};

	/**
	 * One request at a time. `work` reports its own outcome; whatever it throws shows as `failure`. The controls are only
	 * disabled once `work` calls `begin`, which it does after any confirm dialog: a disabled menu button would otherwise
	 * lose the focus the dialog hands back. When all is over `returnFocus` puts focus back on the control that started it.
	 */
	async function guarded(failure: CopyDescriptor, work: (begin: () => void) => Promise<void>, returnFocus?: () => void) {
		if (busyRef.current) return;
		busyRef.current = true;
		setNotice(null);
		try {
			await work(() => setBusy(true));
		} catch {
			say("error", failure);
		} finally {
			busyRef.current = false;
			setBusy(false);
			// After the dialog has unmounted and the controls are enabled again.
			if (returnFocus) requestAnimationFrame(returnFocus);
		}
	}

	function changeCategory(row: SubscriptionRowData, category: SubscriptionCategory, returnFocus?: () => void) {
		if (!mailboxId) return;
		void guarded({ key: "subscriptions.categoryFailed" }, async (begin) => {
			begin();
			const result = await saveSenderCategory({ mailboxId, senderAddress: row.senderAddress, category: categoryToApi(category) });
			say("ok", categoryResultCopy(category, result));
			await refresh();
		}, returnFocus);
	}

	/** The reader's flow: the route picks one-click, mailto or link; this only reports which. Throws when it fails. */
	async function unsubscribe(row: SubscriptionRowData): Promise<CopyDescriptor> {
		const result = await requestUnsubscribe(row.latestMessageId!);
		if (result.method === "link") {
			openUnsubscribeUrl(result.url);
			return { key: "actions.unsubscribeLinkOpened" };
		}
		return { key: result.method === "mailto" ? "actions.unsubscribeEmailSent" : "actions.unsubscribed" };
	}

	function runAction(row: SubscriptionRowData, action: SubscriptionRowAction, returnFocus: () => void) {
		if (!mailboxId) return;
		const target = { mailboxId, senderAddress: row.senderAddress };
		const failure: Record<SubscriptionRowAction, CopyDescriptor> = {
			unsubscribe: { key: "actions.unsubscribeFailed" },
			unsubscribeTrash: { key: "actions.unsubscribeFailed" },
			block: { key: "subscriptions.blockFailed" },
			trash: { key: "subscriptions.trashFailed" },
		};
		void guarded(failure[action], async (begin) => {
			if (action === "unsubscribe") {
				if (!(await confirmDialog({ title: t("actions.unsubscribeConfirmTitle"), message: t("actions.unsubscribeConfirmDescription"), confirmLabel: t("actions.unsubscribe") }))) return;
				begin();
				say("ok", await unsubscribe(row));
			} else if (action === "block") {
				if (!(await confirmDestructive({ title: t("subscriptions.blockConfirmTitle"), message: t("subscriptions.blockConfirm", { sender: row.senderAddress }), confirmLabel: t("subscriptions.action.block") }))) return;
				begin();
				await blockMessageContact(target);
				say("ok", { key: "subscriptions.blockDone", vars: { sender: row.senderAddress } });
			} else {
				const preview = await previewSenderTrash(target);
				const copy = trashConfirmCopy(action, preview);
				if (!copy) {
					// Nothing of the last 90 days to move: an unsubscribe-and-trash is just the unsubscribe.
					if (action === "trash") return say("ok", { key: "subscriptions.trashNothing" });
					if (!(await confirmDialog({ title: t("actions.unsubscribeConfirmTitle"), message: t("actions.unsubscribeConfirmDescription"), confirmLabel: t("actions.unsubscribe") }))) return;
					begin();
					say("ok", await unsubscribe(row));
					return refresh();
				}
				const message = copy.map((item) => t(item.key, item.vars)).join("\n\n");
				const label = action === "trash" ? "subscriptions.action.trash" : "subscriptions.action.unsubscribeTrash";
				if (!(await confirmDestructive({ title: t(action === "trash" ? "subscriptions.trashConfirmTitle" : "subscriptions.unsubscribeTrashConfirmTitle"), message, confirmLabel: t(label) }))) return;
				begin();
				const done: CopyDescriptor[] = [];
				if (action === "unsubscribeTrash") {
					// Unsubscribe first: if the sender offers no way out, nothing is trashed.
					done.push(await unsubscribe(row));
				}
				try {
					done.push(...trashResultCopy(await trashSender(target)));
				} catch {
					done.push(failure.trash);
					say("error", ...done);
					return refresh();
				}
				say("ok", ...done);
			}
			await refresh();
		}, returnFocus);
	}

	if (mailboxesLoading || !countsSeen) return <PageShell><Skeleton className="h-48 rounded-xl" /></PageShell>;
	if (choices.length === 0 || !mailboxId) {
		return (
			<PageShell>
				<div className="rounded-xl bg-neutral-50 p-6">
					<p className="text-sm text-neutral-700">{t("subscriptions.noMailbox")}</p>
					<Link href="/settings/inbox" className="mt-3 inline-block text-sm font-medium text-blue-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
						{t("subscriptions.openSettings")}
					</Link>
				</div>
			</PageShell>
		);
	}

	const pager = getPager({ offset, count: list.senders.length, total: list.total, pageSize: SUBSCRIPTIONS_PAGE_SIZE });
	const rows = list.senders.map((row) => ({ row, view: getRowView(row, permission) }));
	const props = (item: (typeof rows)[number]) => ({
		...item,
		busy,
		onCategory: (category: SubscriptionCategory, returnFocus?: () => void) => changeCategory(item.row, category, returnFocus),
		onAction: (action: SubscriptionRowAction, returnFocus: () => void) => runAction(item.row, action, returnFocus),
	});

	return (
		<PageShell>
			{choices.length > 1 && (
				<Select
					value={mailboxId}
					onChange={(event) => chooseMailbox(event.target.value)}
					aria-label={t("subscriptions.mailbox")}
					className="py-1.5 text-sm text-neutral-800"
					containerClassName="mb-4 w-full sm:w-72"
				>
					{choices.map((item) => <option key={item.id} value={item.id}>{getMailboxAddress(item) ?? item.id}</option>)}
				</Select>
			)}
			<div role="status" aria-live="polite" className="empty:hidden">
				{notice?.tone === "ok" && <p className="mb-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-900">{notice.items.map((item) => t(item.key, item.vars)).join(" ")}</p>}
			</div>
			{notice?.tone === "error" && <p role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{notice.items.map((item) => t(item.key, item.vars)).join(" ")}</p>}
			{!rows.length || list.status !== "ready" ? (
				<ListMessage state={list.status} onRetry={() => void load(mailboxId, offset)} />
			) : (
				<div aria-busy={busy}>
					<table className="hidden w-full table-fixed text-start text-sm md:table">
						<caption className="sr-only">{t("navigation.subscriptions")}</caption>
						<thead className="border-b border-neutral-200 text-xs font-medium uppercase text-neutral-600">
							<tr>
								<th scope="col" className="w-[34%] py-2 pe-3">{t("subscriptions.col.sender")}</th>
								<th scope="col" className="py-2 pe-3">{t("subscriptions.col.messages")}</th>
								<th scope="col" className="py-2 pe-3">{t("subscriptions.col.lastReceived")}</th>
								<th scope="col" className="w-20 py-2 pe-3">{t("subscriptions.col.readRate")}</th>
								<th scope="col" className="w-48 py-2 pe-3">{t("subscriptions.col.category")}</th>
								<th scope="col" className="w-14 py-2"><span className="sr-only">{t("subscriptions.col.actions")}</span></th>
							</tr>
						</thead>
						<tbody>
							{rows.map((item) => (
								<tr key={item.row.senderAddress} className="border-b border-neutral-100 align-top">
									<th scope="row" className="py-3 pe-3 font-normal"><SenderCell {...item} /></th>
									<td className="py-3 pe-3 text-neutral-800"><MessageCount count={item.row.total} /></td>
									<td className="py-3 pe-3 text-neutral-800"><LastReceived value={item.row.lastReceived} /></td>
									<td className="py-3 pe-3 text-neutral-800"><ReadRate rate={item.row.readRate} /></td>
									<td className="py-2.5 pe-3"><CategoryControl {...props(item)} /></td>
									<td className="py-2 text-end"><RowActions {...props(item)} /></td>
								</tr>
							))}
						</tbody>
					</table>
					<ul className="divide-y divide-neutral-100 md:hidden">
						{rows.map((item) => (
							<li key={item.row.senderAddress} className="space-y-3 py-4">
								<div className="flex items-start justify-between gap-2">
									<SenderCell {...item} />
									<RowActions {...props(item)} />
								</div>
								<dl className="grid grid-cols-3 gap-2 text-sm">
									<Stat label={t("subscriptions.col.messages")}><MessageCount count={item.row.total} /></Stat>
									<Stat label={t("subscriptions.col.lastReceived")}><LastReceived value={item.row.lastReceived} /></Stat>
									<Stat label={t("subscriptions.col.readRate")}><ReadRate rate={item.row.readRate} /></Stat>
								</dl>
								<div className="flex items-center gap-2 text-sm">
									<span className="text-neutral-600">{t("subscriptions.col.category")}</span>
									<CategoryControl {...props(item)} />
								</div>
							</li>
						))}
					</ul>
					{!rows.some((item) => item.view.canChange) && <p className="mt-4 text-sm text-neutral-600">{t("settings.promotions.readOnlyNote")}</p>}
					<nav aria-label={t("subscriptions.pager.label")} className="mt-4 flex items-center justify-between gap-3">
						<span className="text-sm text-neutral-600">{t("subscriptions.pager.range", { start: pager.start, end: pager.end, total: pager.total })}</span>
						<span className="flex gap-2">
							<Button type="button" variant="outline" size="sm" className="max-md:h-11" disabled={pager.prevOffset === null || busy} aria-label={t("list.previousPage")} onClick={() => setOffset(pager.prevOffset ?? 0)}>
								<ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
							</Button>
							<Button type="button" variant="outline" size="sm" className="max-md:h-11" disabled={pager.nextOffset === null || busy} aria-label={t("list.nextPage")} onClick={() => setOffset(pager.nextOffset ?? 0)}>
								<ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
							</Button>
						</span>
					</nav>
				</div>
			)}
		</PageShell>
	);
}

function PageShell({ children }: { children: React.ReactNode }) {
	const { t } = useLanguage();
	return (
		<div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
			<h1 className="text-xl font-semibold text-neutral-900">{t("navigation.subscriptions")}</h1>
			<p className="mb-5 mt-1 text-sm text-neutral-600">{t("subscriptions.description")}</p>
			{children}
		</div>
	);
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="min-w-0">
			<dt className="text-xs text-neutral-600">{label}</dt>
			<dd className="text-neutral-900">{children}</dd>
		</div>
	);
}

function ListMessage({ state, onRetry }: { state: ListState["status"]; onRetry: () => void }) {
	const { t } = useLanguage();
	if (state === "loading") return <div aria-busy="true" role="status"><span className="sr-only">{t("common.loading")}</span><Skeleton className="h-48 rounded-xl" /></div>;
	if (state === "error") {
		return (
			<div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl bg-red-50 p-4 text-sm text-red-800">
				<span>{t("subscriptions.loadFailed")}</span>
				<Button type="button" variant="outline" size="sm" onClick={onRetry}>{t("subscriptions.retry")}</Button>
			</div>
		);
	}
	return <p className="rounded-xl bg-neutral-50 p-6 text-sm text-neutral-700">{t("subscriptions.empty")}</p>;
}
