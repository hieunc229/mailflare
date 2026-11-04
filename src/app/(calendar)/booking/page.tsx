"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { mobilePrimaryActionClass } from "@/components/page-header-utils";
import clsx from "clsx";
import { CalendarDays, Check, Clock3, Copy, ExternalLink, MapPin, MoreHorizontal, Plus } from "@/components/icons";
import toast, { Toaster } from "react-hot-toast";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { RouteLoadingBarPortal } from "@/components/route-loading-bar-portal";
import { authFetch } from "@/lib/auth/client";
import { getUserTimeZone } from "@/lib/time/utils";
import { useSidebar } from "@/components/sidebar-state";
import { UpcomingSidebar } from "../upcoming-sidebar";
import { BookingEditor } from "./booking-editor";
import { BookingListSkeleton } from "./booking-list-skeleton";
import { visibleBookingEvents } from "./default-events";
import type { BookingEvent, BookingForm, BookingHost } from "./types";
import { availabilityLabel, durationLabel, emptyBookingForm, formFromEvent } from "./utils";

export default function BookingsPage() {
	const { t } = useLanguage();
	const { minimal: sidebarMinimal, mobile } = useSidebar();
	const minimal = sidebarMinimal || mobile;
	const [events, setEvents] = useState<BookingEvent[]>([]);
	const [username, setUsername] = useState("");
	const [hosts, setHosts] = useState<BookingHost[]>([]);
	const [canManageHosts, setCanManageHosts] = useState(false);
	const [currentUserId, setCurrentUserId] = useState("");
	const [loading, setLoading] = useState(true);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState<BookingForm | null>(null);
	const [panelOpen, setPanelOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [menuId, setMenuId] = useState<string | null>(null);
	const [savingTemplateId, setSavingTemplateId] = useState<string | null>(null);
	const listEvents = visibleBookingEvents(events, currentUserId, getUserTimeZone());

	useEffect(() => {
		let active = true;
		void authFetch("/api/booking").then(async (response) => {
			if (!response.ok) throw new Error();
			return response.json() as Promise<{ events: BookingEvent[]; username: string | null; currentUser: BookingHost; canManageHosts: boolean }>;
		}).then(async (data) => {
			if (active) { setEvents(data.events); setUsername(data.username ?? ""); setHosts([data.currentUser]); setCurrentUserId(data.currentUser.id); }
			if (!data.canManageHosts) return;
			const response = await authFetch("/api/accounts");
			if (!response.ok) { if (active) toast.error(t("booking.hostListFailed")); return; }
			const accounts = await response.json() as { accounts: (BookingHost & { disabled: boolean })[] };
			if (active) { setHosts([data.currentUser, ...accounts.accounts.filter((account) => !account.disabled && account.id !== data.currentUser.id).map(({ id, name, email, hasAvatar }) => ({ id, name, email, hasAvatar }))]); setCanManageHosts(true); }
		})
			.catch(() => { if (active) toast.error(t("booking.loadFailed")); })
			.finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, [t]);

	useEffect(() => {
		if (panelOpen || !form) return;
		const timeout = window.setTimeout(() => { setForm(null); setEditingId(null); }, 320);
		return () => window.clearTimeout(timeout);
	}, [panelOpen, form]);

	function revealPanel() { setPanelOpen(false); requestAnimationFrame(() => requestAnimationFrame(() => setPanelOpen(true))); }
	function startCreate() { if (!currentUserId) return; setEditingId(null); setForm(emptyBookingForm(getUserTimeZone(), currentUserId)); setMenuId(null); revealPanel(); }
	function startEdit(event: BookingEvent) { setEditingId(event.isTemplate ? null : event.id); setForm({ ...formFromEvent(event), enabled: event.isTemplate ? true : event.enabled }); setMenuId(null); if (!panelOpen) revealPanel(); }
	function closeEditor() { setPanelOpen(false); }

	async function save() {
		if (!form) return;
		setSaving(true);
		try {
			const response = await authFetch(editingId ? `/api/booking/${editingId}` : "/api/booking", { method: editingId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
			const data = await response.json() as { event?: BookingEvent; error?: string };
			if (!response.ok || !data.event) { toast.error(data.error ?? t("booking.saveFailed")); return; }
			setEvents((current) => editingId ? current.map((item) => item.id === editingId ? data.event! : item) : [...current, data.event!]);
			closeEditor();
			toast.success(editingId ? t("booking.saved") : t("booking.created"));
		} catch { toast.error(t("booking.saveFailed")); }
		finally { setSaving(false); }
	}

	async function setEnabled(event: BookingEvent, enabled: boolean) {
		if (event.isTemplate && !enabled) return;
		if (event.isTemplate) setSavingTemplateId(event.id);
		try {
			const response = await authFetch(event.isTemplate ? "/api/booking" : `/api/booking/${event.id}`, { method: event.isTemplate ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...formFromEvent(event), enabled }) });
			const data = await response.json() as { event?: BookingEvent; error?: string };
			if (!response.ok || !data.event) throw new Error(data.error);
			setEvents((current) => event.isTemplate ? [...current, data.event!] : current.map((item) => item.id === event.id ? data.event! : item));
			if (editingId === event.id && form) setForm({ ...form, enabled });
			setMenuId(null);
		} catch { toast.error(event.isTemplate ? t("booking.enableFailed") : t("booking.updateFailed")); }
		finally { if (event.isTemplate) setSavingTemplateId(null); }
	}

	async function remove(event: BookingEvent) {
		if (!window.confirm(t("booking.deleteConfirm", { name: event.name }))) return;
		try {
			const response = await authFetch(`/api/booking/${event.id}`, { method: "DELETE" });
			if (!response.ok) throw new Error();
			setEvents((current) => current.filter((item) => item.id !== event.id));
			if (editingId === event.id) closeEditor();
			setMenuId(null);
		} catch { toast.error(t("booking.deleteFailed")); }
	}

	async function copyLink(event: BookingEvent) {
		if (!username) { toast.error(t("booking.usernameUnavailable")); return; }
		try { await navigator.clipboard.writeText(`${window.location.origin}/c/${username}/${event.slug}`); toast.success(t("booking.linkCopied")); }
		catch { toast.error(t("booking.copyFailed")); }
	}

	return <div className={clsx("flex h-full min-h-0 flex-col bg-[#f6f8fc] pl-3 max-md:pl-0 transition-[gap] duration-200 ease-in-out motion-reduce:transition-none lg:flex-row", minimal ? "gap-0" : "gap-3")}>
		<Toaster position="bottom-left" />
		{loading && <RouteLoadingBarPortal />}
		<UpcomingSidebar />
		<section className="min-h-0 min-w-0 flex-1 overflow-hidden overscroll-contain max-md:rounded-t-3xl max-md:bg-white">
			<div className="flex h-full min-h-0 min-w-0">
				<div className="min-w-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-stable">
					<div className="mx-auto max-w-6xl px-5 md:px-8">
						<section aria-label={t("booking.events")} className="space-y-1 pt-3 max-md:pb-24">

							<div className="flex flex-wrap items-start justify-between gap-4 pb-6 max-md:flex-nowrap max-md:gap-2">
								<div className="min-w-0"><h1 className="text-xl font-semibold text-neutral-900 md:text-3xl">{t("booking.title")}</h1><p className="mt-1 text-sm text-neutral-500">{t("booking.description")}</p></div>
								<div className="flex shrink-0 items-center gap-2">

									<Button asChild variant="ghost" className="w-10 max-md:-mr-2">
										<Link href={`/c/${username}`} target="_blank" rel="noopener noreferrer" aria-label={t("booking.openPage", { name: username })} className="text-blue-700">
											<ExternalLink size={18} aria-hidden="true" />
										</Link>
									</Button>

									<Button type="button" onClick={startCreate} disabled={!currentUserId} className={clsx("rounded-full", mobilePrimaryActionClass)}><Plus size={18} />{t("booking.newEvent")}</Button></div>
							</div>

							{loading ? <BookingListSkeleton /> : listEvents.length === 0 ? <div className="rounded-2xl border border-dashed border-neutral-300 bg-white px-6 py-12 text-center"><CalendarDays className="mx-auto mb-3 h-8 w-8 text-neutral-400" /><h2 className="font-medium text-neutral-900">{t("booking.none")}</h2><p className="mt-1 text-sm text-neutral-500">{t("booking.noneHint")}</p></div> : listEvents.map((event, i) => <article key={event.id} className={clsx(!event.enabled && "opacity-65", `relative flex flex-wrap items-center gap-4 rounded-md bg-white px-5 py-5 max-md:gap-3 max-md:rounded-none max-md:border-b max-md:border-neutral-100 max-md:px-0 max-md:py-4 max-md:last:border-b-0`, i === 0 && "rounded-t-3xl")}>
								<div className="flex min-w-0 flex-1 items-start gap-4"><span className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${event.enabled ? "border-blue-600 bg-blue-600 text-white" : "border-neutral-300"}`}>{event.enabled && <Check className="h-3.5 w-3.5" />}</span><div className="min-w-0"><button type="button" onClick={() => startEdit(event)} className="text-left text-lg font-semibold text-neutral-900 hover:text-blue-700 max-md:text-base">{event.name}</button>{event.description && <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-neutral-600">{event.description}</p>}<p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-neutral-500"><span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />{durationLabel(event.durationMinutes, t)}</span><span>·</span><span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{event.location || t("booking.noLocation")}</span></p><p className="mt-2 text-sm text-neutral-500">{availabilityLabel(event, t)}</p></div></div>
								<div className="ml-auto flex items-center gap-2 max-md:ml-9 max-md:w-full">{event.enabled ? <><Button type="button" variant="outline" onClick={() => void copyLink(event)} className="h-9 rounded-full px-3"><Copy className="h-4 w-4" />{t("booking.copyLink")}</Button>{username && <Link href={`/c/${username}/${event.slug}`} target="_blank" aria-label={t("booking.openPage", { name: event.name })} className="rounded-full p-2 text-neutral-600 hover:bg-neutral-100"><ExternalLink className="h-4 w-4" /></Link>}</> : <Button type="button" variant="outline" disabled={event.isTemplate && savingTemplateId !== null} onClick={() => void setEnabled(event, true)} className="h-9 rounded-full px-3">{savingTemplateId === event.id ? t("booking.turningOn") : t("booking.turnOn")}</Button>}
									{!event.isTemplate && <div className="relative"><button type="button" aria-label={t("booking.moreOptions", { name: event.name })} aria-expanded={menuId === event.id} onClick={() => setMenuId(menuId === event.id ? null : event.id)} className="rounded-full p-2 text-neutral-600 hover:bg-neutral-100"><MoreHorizontal className="h-5 w-5" /></button>{menuId === event.id && <div className="absolute right-0 top-10 z-10 w-36 rounded-xl border border-neutral-200 bg-white p-1 shadow-lg"><button type="button" onClick={() => startEdit(event)} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100">{t("booking.edit")}</button><button type="button" onClick={() => void setEnabled(event, !event.enabled)} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100">{event.enabled ? t("booking.turnOff") : t("booking.turnOn")}</button><button type="button" onClick={() => void remove(event)} className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50">{t("common.delete")}</button></div>}</div>}</div>
							</article>)}
						</section>
					</div>
				</div>
				{form && <BookingEditor form={form} open={panelOpen} editingId={editingId} username={username} hosts={hosts} canManageHosts={canManageHosts} currentUserId={currentUserId} saving={saving} onChange={setForm} onClose={closeEditor} onSave={() => void save()} onDelete={() => { const event = events.find((item) => item.id === editingId); if (event) void remove(event); }} onToggleEnabled={() => { const event = events.find((item) => item.id === editingId); if (event) void setEnabled(event, !event.enabled); }} onClosed={() => { if (!panelOpen) { setForm(null); setEditingId(null); } }} />}
			</div>
		</section>
	</div>;
}
