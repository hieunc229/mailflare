"use client";

import { useId } from "react";
import { AlertCircle, Loader2, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { CalendarGrantRole, ShareEntry } from "@/lib/calendar/shares-types";

const touch = "[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";
const ROLES: CalendarGrantRole[] = ["freebusy", "read", "edit", "manage"];

export type ShareViewProps = {
	state: "loading" | "ready" | "error";
	shares: ShareEntry[];
	/** The grant being changed or removed: its row is disabled until the request settles. */
	pendingId: string | null;
	email: string;
	role: CalendarGrantRole;
	adding: boolean;
	/** Translated text of the last failed request, or "". */
	error: string;
	onEmail: (value: string) => void;
	onRole: (value: CalendarGrantRole) => void;
	onAdd: () => void;
	onChangeRole: (share: ShareEntry, role: CalendarGrantRole) => void;
	onRemove: (share: ShareEntry) => void;
	onRetry: () => void;
};

/** Presentation only: the container owns the requests, so every state can be rendered and tested on its own. */
export function ShareView(props: ShareViewProps) {
	const { t } = useLanguage();
	const titleId = useId();
	const hintId = useId();
	const emailId = useId();
	const roleLabel = (role: CalendarGrantRole) => t(`calendar.share.role.${role}` as never);
	return (
		<section aria-labelledby={titleId} className="mt-5 space-y-3 border-t border-neutral-100 pt-4 text-sm">
			<div>
				<h3 id={titleId} className="font-semibold text-neutral-900">{t("calendar.share.title")}</h3>
				<p className="mt-0.5 text-xs text-neutral-600">{t("calendar.share.description")}</p>
			</div>
			{props.state === "loading" && (
				<p role="status" className="flex items-center gap-2 text-neutral-500"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("calendar.share.loading")}</p>
			)}
			{props.state === "error" && (
				<div role="alert" className="flex items-start gap-2 text-red-700">
					<AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
					<span className="min-w-0 flex-1">{t("calendar.share.loadFailed")}</span>
					<button type="button" onClick={props.onRetry} className={`rounded-md px-2 font-medium text-blue-700 underline hover:bg-blue-50 ${touch}`}>{t("calendar.calendars.retry")}</button>
				</div>
			)}
			{props.state === "ready" && (props.shares.length === 0
				? <p className="text-neutral-600">{t("calendar.share.empty")}</p>
				: (
					<ul className="space-y-2">
						{props.shares.map((share) => {
							const who = share.name || share.email;
							const busy = props.pendingId === share.id;
							return (
								<li key={share.id} aria-busy={busy} className="flex flex-wrap items-center gap-2">
									<div className="min-w-0 flex-1 basis-40">
										<p className="truncate font-medium text-neutral-900">{who}</p>
										{share.name && <p className="truncate text-xs text-neutral-600">{share.email}</p>}
									</div>
									<Select value={share.role} containerClassName="contents" disabled={busy} aria-label={t("calendar.share.roleFor", { name: who })}
										onChange={(event) => props.onChangeRole(share, event.target.value as CalendarGrantRole)}
										className="h-9 min-w-0 max-w-full rounded-md border border-neutral-200 pl-2 pr-2 text-sm text-neutral-700 hover:bg-neutral-50 focus-visible:border-blue-600 [@media(pointer:coarse)]:min-h-11">
										{ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
									</Select>
									<button type="button" disabled={busy} onClick={() => props.onRemove(share)} aria-label={t("calendar.share.remove", { name: who })} title={t("calendar.share.remove", { name: who })}
										className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-red-50 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-50 ${touch}`}>
										{busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Trash2 aria-hidden="true" className="h-4 w-4" />}
									</button>
								</li>
							);
						})}
					</ul>
				))}
			<form onSubmit={(event) => { event.preventDefault(); if (props.email.trim() && !props.adding) props.onAdd(); }} className="space-y-2">
				<div className="flex flex-wrap items-end gap-2">
					<div className="min-w-0 flex-1 basis-48">
						<label htmlFor={emailId} className="mb-1 block text-xs font-medium text-neutral-800">{t("calendar.share.email")}</label>
						<Input id={emailId} type="email" value={props.email} onChange={(event) => props.onEmail(event.target.value)} placeholder={t("calendar.share.emailPlaceholder")} autoComplete="off" maxLength={254}
							aria-describedby={hintId} className="w-full [@media(pointer:coarse)]:min-h-11" />
					</div>
					<Select value={props.role} containerClassName="contents" disabled={props.adding} aria-label={t("calendar.share.role")} onChange={(event) => props.onRole(event.target.value as CalendarGrantRole)}
						className="h-9 min-w-0 max-w-full rounded-md border border-neutral-200 pl-2 pr-2 text-sm text-neutral-700 hover:bg-neutral-50 focus-visible:border-blue-600 [@media(pointer:coarse)]:min-h-11">
						{ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
					</Select>
					<Button type="submit" disabled={!props.email.trim() || props.adding} className="[@media(pointer:coarse)]:min-h-11">{props.adding ? t("calendar.share.adding") : t("calendar.share.add")}</Button>
				</div>
				<p id={hintId} className="text-xs text-neutral-600">{t("calendar.share.hint")}</p>
				{props.error && <p role="alert" className="text-red-700">{props.error}</p>}
			</form>
		</section>
	);
}
