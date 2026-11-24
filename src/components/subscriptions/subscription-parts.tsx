"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useRef } from "react";
import { Ban, BellOff, MoreVertical, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { daysSince, formatReadRate } from "@/lib/promotions/subscriptions-ui-utils";
import type { SubscriptionCategory, SubscriptionRowAction } from "@/lib/promotions/subscriptions-ui-types";
import { formatUserDate } from "@/lib/time/utils";
import type { TranslationKey } from "@/lib/i18n/types";
import type { SubscriptionRowProps } from "./subscription-parts-types";

const CATEGORY_LABELS: Record<SubscriptionCategory, TranslationKey> = {
	auto: "subscriptions.category.auto",
	inbox: "subscriptions.category.inbox",
	promotions: "subscriptions.category.promotions",
};
const CATEGORIES: SubscriptionCategory[] = ["auto", "inbox", "promotions"];

const ACTION_LABELS: Record<SubscriptionRowAction, TranslationKey> = {
	unsubscribe: "actions.unsubscribe",
	unsubscribeTrash: "subscriptions.action.unsubscribeTrash",
	block: "subscriptions.action.block",
	trash: "subscriptions.action.trash",
};
const ACTION_ICONS = { unsubscribe: BellOff, unsubscribeTrash: BellOff, block: Ban, trash: Trash2 } as const;

const DATE_FORMAT: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };

export function SenderCell({ row, view }: Pick<SubscriptionRowProps, "row" | "view">) {
	const { t } = useLanguage();
	const named = row.displayName && row.displayName !== row.senderAddress;
	return (
		<div className="min-w-0">
			{named && <p className="truncate font-medium text-neutral-900">{row.displayName}</p>}
			<p className={named ? "truncate text-sm text-neutral-600" : "truncate font-medium text-neutral-900"}>{row.senderAddress}</p>
			{(view.unsubscribedOn || view.stillSending) && (
				<p className="mt-1 flex flex-wrap gap-1.5">
					{view.unsubscribedOn && (
						<span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800">
							{t("subscriptions.unsubscribedOn", { date: formatUserDate(view.unsubscribedOn, DATE_FORMAT) })}
						</span>
					)}
					{view.stillSending && (
						<span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900" title={t("subscriptions.stillSendingHelp")}>
							{t("subscriptions.stillSending")}
							<span className="sr-only">. {t("subscriptions.stillSendingHelp")}</span>
						</span>
					)}
				</p>
			)}
		</div>
	);
}

export function MessageCount({ count }: { count: number }) {
	const { t } = useLanguage();
	return <>{t("subscriptions.messages", { count })}</>;
}

export function LastReceived({ value }: { value: string }) {
	const { locale } = useLanguage();
	const days = daysSince(value, new Date());
	return (
		<time dateTime={value} title={formatUserDate(value, { ...DATE_FORMAT, hour: "numeric", minute: "2-digit" })}>
			{new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-days, "day")}
		</time>
	);
}

export const ReadRate = ({ rate }: { rate: number }) => <>{formatReadRate(rate)}</>;

/** The sender's Inbox/Promotions rule. People without full access see the current setting as text. */
export function CategoryControl({ row, view, busy, onCategory }: SubscriptionRowProps) {
	const { t } = useLanguage();
	const trigger = useRef<HTMLButtonElement>(null);
	if (!view.canChange) return <span className="text-sm text-neutral-700">{t(CATEGORY_LABELS[view.category])}</span>;
	return (
		<Select
			value={view.category}
			disabled={busy}
			ref={trigger}
			onChange={(event) => onCategory(event.target.value as SubscriptionCategory, () => trigger.current?.focus())}
			aria-label={t("subscriptions.categoryLabel", { sender: row.senderAddress })}
			className="py-1.5 text-sm text-neutral-800"
			containerClassName="w-full md:w-44"
		>
			{CATEGORIES.map((category) => <option key={category} value={category}>{t(CATEGORY_LABELS[category])}</option>)}
		</Select>
	);
}

/** Keyboard-reachable row menu; absent entirely when the user has no actions. */
export function RowActions({ row, view, busy, onAction }: SubscriptionRowProps) {
	const { t } = useLanguage();
	const trigger = useRef<HTMLButtonElement>(null);
	if (view.actions.length === 0) return null;
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<Button ref={trigger} type="button" variant="ghost" size="sm" disabled={busy} className="h-9 w-9 p-0 max-md:h-11 max-md:w-11" aria-label={t("subscriptions.actionsFor", { sender: row.senderAddress })}>
					<MoreVertical className="h-4 w-4" aria-hidden="true" />
				</Button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-56 rounded-lg border border-neutral-200 bg-white p-1 text-sm shadow-lg">
					{view.actions.map((action) => {
						const Icon = ACTION_ICONS[action];
						const danger = action === "trash" || action === "block";
						return (
							<DropdownMenu.Item
								key={action}
								disabled={busy}
								onSelect={() => onAction(action, () => trigger.current?.focus())}
								className={`flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 max-md:min-h-11 ${danger ? "text-red-700 hover:bg-red-50 focus:bg-red-50" : "text-neutral-800 hover:bg-neutral-100 focus:bg-neutral-100"}`}
							>
								<Icon className="h-4 w-4" aria-hidden="true" />
								{t(ACTION_LABELS[action])}
							</DropdownMenu.Item>
						);
					})}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
